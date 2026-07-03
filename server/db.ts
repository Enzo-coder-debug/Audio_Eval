import { eq, and, desc, isNull, lte, gte, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { 
  InsertUser, 
  users,
  audioFiles,
  questionnaires,
  questions,
  responses,
  answers,
  questionnaireStats,
  evaluationDimensions,
  blindTestPairs,
  type AudioFile,
  type Questionnaire,
  type Question,
  type Response,
  type Answer,
  type EvaluationDimension,
  type InsertEvaluationDimension,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Audio file operations
 */
export async function createAudioFile(file: typeof audioFiles.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(audioFiles).values(file);
  return result;
}

export async function getAudioFileById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(audioFiles).where(eq(audioFiles.id, id)).limit(1);
  return result[0];
}

export async function getAudioFilesByUploader(uploaderId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(audioFiles)
    .where(eq(audioFiles.uploaderId, uploaderId))
    .orderBy(desc(audioFiles.createdAt));
}

export async function updateAudioFile(id: number, updates: Partial<typeof audioFiles.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(audioFiles)
    .set(updates)
    .where(eq(audioFiles.id, id));
}

/**
 * Questionnaire operations
 */
export async function createQuestionnaire(questionnaire: typeof questionnaires.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(questionnaires).values(questionnaire);
  return result;
}

export async function getQuestionnaireById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(questionnaires)
    .where(eq(questionnaires.id, id))
    .limit(1);
  return result[0];
}

export async function getQuestionnairesByCreator(creatorId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(questionnaires)
    .where(eq(questionnaires.creatorId, creatorId))
    .orderBy(desc(questionnaires.createdAt));
}

export async function getPublishedQuestionnaires() {
  const db = await getDb();
  if (!db) return [];
  
  const now = new Date();
  return await db.select().from(questionnaires)
    .where(and(
      eq(questionnaires.status, 'published'),
      or(isNull(questionnaires.validFrom), lte(questionnaires.validFrom, now)),
      or(isNull(questionnaires.validUntil), gte(questionnaires.validUntil, now))
    ))
    .orderBy(desc(questionnaires.publishedAt));
}

export async function updateQuestionnaire(id: number, updates: Partial<typeof questionnaires.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(questionnaires)
    .set(updates)
    .where(eq(questionnaires.id, id));
}

export async function getQuestionnaireByShareToken(shareToken: string) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(questionnaires)
    .where(and(
      eq(questionnaires.shareToken, shareToken),
      eq(questionnaires.status, 'published')
    ))
    .limit(1);
  return result[0];
}

/**
 * Question operations
 */
export async function createQuestions(questionList: (typeof questions.$inferInsert)[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.insert(questions).values(questionList);
}

export async function getQuestionsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(questions)
    .where(eq(questions.questionnaireId, questionnaireId))
    .orderBy(questions.orderIndex);
}

/**
 * Response operations
 */
export async function createResponse(response: typeof responses.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(responses).values(response);
  return result;
}

export async function getResponseById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(responses)
    .where(eq(responses.id, id))
    .limit(1);
  return result[0];
}

export async function getUserResponse(userId: number, questionnaireId: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(responses)
    .where(and(
      eq(responses.userId, userId),
      eq(responses.questionnaireId, questionnaireId)
    ))
    .limit(1);
  return result[0];
}

export async function getUserResponses(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(responses)
    .where(eq(responses.userId, userId))
    .orderBy(desc(responses.createdAt));
}

export async function getQuestionnaireResponses(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(responses)
    .where(eq(responses.questionnaireId, questionnaireId))
    .orderBy(desc(responses.submittedAt));
}

export async function getBlindTestPairById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(blindTestPairs)
    .where(eq(blindTestPairs.id, id))
    .limit(1);
  return result[0];
}

export async function getBlindTestPairsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(blindTestPairs)
    .where(eq(blindTestPairs.questionnaireId, questionnaireId))
    .orderBy(blindTestPairs.pairIndex);
}

export async function createBlindTestPairs(pairs: (typeof blindTestPairs.$inferInsert)[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.insert(blindTestPairs).values(pairs);
}

export async function createAnonymousResponse(response: typeof responses.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(responses).values(response);
  return result;
}

export async function updateResponse(id: number, updates: Partial<typeof responses.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(responses)
    .set(updates)
    .where(eq(responses.id, id));
}

/**
 * Answer operations
 */
export async function createAnswers(answerList: (typeof answers.$inferInsert)[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.insert(answers).values(answerList);
}

export async function getAnswersByResponse(responseId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(answers)
    .where(eq(answers.responseId, responseId))
    .orderBy(answers.createdAt);
}

export async function updateAnswer(id: number, updates: Partial<typeof answers.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(answers)
    .set(updates)
    .where(eq(answers.id, id));
}

/**
 * Stats operations
 */
export async function getOrCreateStats(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  let stats = await db.select().from(questionnaireStats)
    .where(eq(questionnaireStats.questionnaireId, questionnaireId))
    .limit(1);
  
  if (!stats.length) {
    await db.insert(questionnaireStats).values({ questionnaireId });
    stats = await db.select().from(questionnaireStats)
      .where(eq(questionnaireStats.questionnaireId, questionnaireId))
      .limit(1);
  }
  
  return stats[0];
}

export async function updateStats(questionnaireId: number, updates: Partial<typeof questionnaireStats.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(questionnaireStats)
    .set(updates)
    .where(eq(questionnaireStats.questionnaireId, questionnaireId));
}

/**
 * Evaluation Dimension operations
 */
export async function createEvaluationDimension(dimension: InsertEvaluationDimension) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.insert(evaluationDimensions).values(dimension);
}

export async function createEvaluationDimensions(dimensions: InsertEvaluationDimension[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (dimensions.length === 0) return;

  return db.insert(evaluationDimensions).values(dimensions);
}

export async function getEvaluationDimensionsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(evaluationDimensions)
    .where(eq(evaluationDimensions.questionnaireId, questionnaireId))
    .orderBy(evaluationDimensions.orderIndex);
}

export async function updateEvaluationDimension(id: number, updates: Partial<InsertEvaluationDimension>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(evaluationDimensions)
    .set(updates)
    .where(eq(evaluationDimensions.id, id));
}

export async function deleteEvaluationDimension(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.delete(evaluationDimensions)
    .where(eq(evaluationDimensions.id, id));
}

/**
 * 盲测音频编辑相关操作
 * 说明:音频(audioFiles)与问卷(questionnaires)之间没有直接外键,
 * 而是通过盲测配对(blindTestPairs)的 left/right 关联。
 * 因此"某问卷用到的音频"需要从配对表反查并去重。
 */

// 取某问卷用到的全部音频(按 audioFileId 去重,保留稳定顺序)。
export async function getAudioFilesByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [] as AudioFile[];

  // 音频现在直接归属问卷(audioFiles.questionnaireId),不再依赖配对表反查,
  // 这样"已上传但尚未生成配对"的音频也能被列出与设置组别。
  const rows = await db.select().from(audioFiles)
    .where(eq(audioFiles.questionnaireId, questionnaireId))
    .orderBy(audioFiles.id);
  return rows;
}

// 删除某问卷的全部盲测配对(重建配对前调用)。
export async function deleteBlindTestPairsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(blindTestPairs).where(eq(blindTestPairs.questionnaireId, questionnaireId));
}

// 删除单个音频记录(仅删记录,OSS 对象保留,避免误删共享文件)。
export async function deleteAudioFile(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(audioFiles).where(eq(audioFiles.id, id));
}

// 统计某问卷是否已有作答记录(改音频前用于风险判断)。
export async function countResponsesByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: responses.id }).from(responses)
    .where(eq(responses.questionnaireId, questionnaireId));
  return rows.length;
}

// 清空某问卷的所有作答与答案(改音频导致旧配对失效时,级联清理避免数据错位)。
export async function deleteResponsesByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const respRows = await db.select({ id: responses.id }).from(responses)
    .where(eq(responses.questionnaireId, questionnaireId));
  for (const r of respRows) {
    await db.delete(answers).where(eq(answers.responseId, r.id));
  }
  await db.delete(responses).where(eq(responses.questionnaireId, questionnaireId));
  await db.delete(questionnaireStats).where(eq(questionnaireStats.questionnaireId, questionnaireId));
}

// 级联删除问卷及其所有关联数据,避免产生孤儿记录。
export async function deleteQuestionnaireCascade(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. 找出该问卷下所有作答记录,先删其答案,再删作答记录。
  const respRows = await db
    .select({ id: responses.id })
    .from(responses)
    .where(eq(responses.questionnaireId, questionnaireId));
  for (const r of respRows) {
    await db.delete(answers).where(eq(answers.responseId, r.id));
  }
  await db.delete(responses).where(eq(responses.questionnaireId, questionnaireId));

  // 2. 删除盲测配对、评分维度、题目、统计。
  await db.delete(blindTestPairs).where(eq(blindTestPairs.questionnaireId, questionnaireId));
  await db.delete(evaluationDimensions).where(eq(evaluationDimensions.questionnaireId, questionnaireId));
  await db.delete(questions).where(eq(questions.questionnaireId, questionnaireId));
  await db.delete(questionnaireStats).where(eq(questionnaireStats.questionnaireId, questionnaireId));

  // 3. 最后删除问卷本身。
  await db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
}

// Helper for OR condition
function or(...conditions: any[]) {
  return conditions.reduce((acc, cond) => acc || cond);
}
