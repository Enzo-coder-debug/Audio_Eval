import { eq, and, desc, isNull, lte, gte, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
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
import { buildFilenameGroupUpdates } from "../shared/audioGroupLabels";
import { TRPCError } from "@trpc/server";
import { summarizeResponses } from "../shared/responseStats";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      // 显式创建连接池并把驱动会话时区统一为东八区(+08:00)。
      // 否则 mysql2 默认按容器本地时区(JDOS 容器常为 UTC)解析 DATETIME,
      // 导致读回的时间比真实北京时间快 8 小时。
      const pool = mysql.createPool({
        uri: process.env.DATABASE_URL,
        timezone: "+08:00",
      });
      _db = drizzle(pool);
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
async function lockMutableQuestionnaire(transaction: Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">, questionnaireId: number | null | undefined) {
  if (questionnaireId == null) return;
  const [questionnaire] = await transaction.select({ plan: questionnaires.subQuestionnairePlan }).from(questionnaires).where(eq(questionnaires.id, questionnaireId)).for("update");
  if (questionnaire?.plan != null) throw new TRPCError({ code: "CONFLICT", message: "已启用固定子问卷，不能更改题库或绕过限额领取；请刷新页面" });
}

export async function createAudioFile(file: typeof audioFiles.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.transaction(async transaction => {
    if (file.modelName !== "__reference__") await lockMutableQuestionnaire(transaction, file.questionnaireId);
    return transaction.insert(audioFiles).values(file);
  });
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
  
  return db.transaction(async transaction => {
    const [audio] = await transaction.select().from(audioFiles).where(eq(audioFiles.id, id));
    await lockMutableQuestionnaire(transaction, audio?.questionnaireId);
    if (updates.questionnaireId != null) await lockMutableQuestionnaire(transaction, updates.questionnaireId);
    return transaction.update(audioFiles).set(updates).where(eq(audioFiles.id, id));
  });
}

export async function updateAudioGroupLabels(
  questionnaireId: number,
  items: { audioFileId: number; groupLabel: string }[],
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const groupedIds = new Map<string | null, number[]>();
  for (const item of items) {
    const label = item.groupLabel.trim() || null;
    const ids = groupedIds.get(label) ?? [];
    ids.push(item.audioFileId);
    groupedIds.set(label, ids);
  }

  await db.transaction(async transaction => {
    await lockMutableQuestionnaire(transaction, questionnaireId);
    for (const [groupLabel, ids] of Array.from(groupedIds.entries())) {
      await transaction.update(audioFiles)
        .set({ groupLabel })
        .where(and(
          eq(audioFiles.questionnaireId, questionnaireId),
          inArray(audioFiles.id, ids),
        ));
    }
  });
}

export async function fillMissingAudioGroupLabels(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async transaction => {
    await lockMutableQuestionnaire(transaction, questionnaireId);
    const audios = await transaction.select().from(audioFiles)
      .where(eq(audioFiles.questionnaireId, questionnaireId)).for("update");
    const items = buildFilenameGroupUpdates(audios);
    for (const item of items) {
      await transaction.update(audioFiles).set({ groupLabel: item.groupLabel })
        .where(and(eq(audioFiles.questionnaireId, questionnaireId), eq(audioFiles.id, item.audioFileId)));
    }
    return { updatedCount: items.length };
  });
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
  
  return db.transaction(async transaction => {
    if (updates.sampleSize !== undefined) await lockMutableQuestionnaire(transaction, id);
    return transaction.update(questionnaires).set(updates).where(eq(questionnaires.id, id));
  });
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
  
  return db.transaction(async transaction => {
    await lockMutableQuestionnaire(transaction, response.questionnaireId);
    return transaction.insert(responses).values(response);
  });
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

export async function deleteQuestionnaireResponse(questionnaireId: number, responseId: number, creatorId: number) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");

  return database.transaction(async transaction => {
    const [questionnaire] = await transaction.select().from(questionnaires)
      .where(eq(questionnaires.id, questionnaireId)).for("update");
    if (!questionnaire || questionnaire.creatorId !== creatorId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "无权删除此问卷的答卷" });
    }
    const [response] = await transaction.select().from(responses)
      .where(and(eq(responses.id, responseId), eq(responses.questionnaireId, questionnaireId)))
      .for("update");
    if (!response) {
      throw new TRPCError({ code: "NOT_FOUND", message: "答卷不存在或已删除，请刷新列表" });
    }

    await transaction.delete(answers).where(eq(answers.responseId, responseId));
    await transaction.delete(responses).where(eq(responses.id, responseId));
    const stats = await recalculateQuestionnaireStats(transaction, questionnaireId);
    return { success: true, responseId, releasedQuota: response.subQuestionnaireIndex != null ? 1 : 0, stats };
  });
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
  
  return db.transaction(async transaction => {
    for (const questionnaireId of Array.from(new Set(pairs.map(pair => pair.questionnaireId))).sort((left, right) => left - right)) await lockMutableQuestionnaire(transaction, questionnaireId);
    return transaction.insert(blindTestPairs).values(pairs);
  });
}

export async function createAnonymousResponse(response: typeof responses.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.transaction(async transaction => {
    await lockMutableQuestionnaire(transaction, response.questionnaireId);
    return transaction.insert(responses).values(response);
  });
}

export async function updateResponse(id: number, updates: Partial<typeof responses.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.update(responses)
    .set(updates)
    .where(eq(responses.id, id));
}

// 查找同问卷、同 IP、同姓名且仍处于 in_progress 的记录(用于复用,避免同一个人每次进入都新建脏数据)。
// 唯一键用 visitorIp + visitorName:同一浏览器换姓名即视为不同答卷人,不会互相复用/覆盖;
// 同 IP 同名中途退出再进则复用续答。(不再用 visitorToken:它同一浏览器恒定,区分不了换人作答。)
export async function findInProgressResponse(questionnaireId: number, visitorIp: string, visitorName: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!visitorIp || !visitorName) return null; // 缺 IP 或姓名时不复用,一律新建
  const rows = await db.select().from(responses)
    .where(and(
      eq(responses.questionnaireId, questionnaireId),
      eq(responses.visitorIp, visitorIp),
      eq(responses.visitorName, visitorName),
      eq(responses.status, "in_progress"),
    ))
    .orderBy(desc(responses.id));
  return rows[0] || null;
}

// 清理同问卷、同 IP、同姓名的其他残留 in_progress 记录(保留 keepResponseId),先删其 answers 再删 response。
// 唯一键用 visitorIp + visitorName:避免误删同一 IP 下其他访客(不同姓名)正在进行的答卷。
export async function deleteStaleInProgressResponses(
  questionnaireId: number,
  visitorIp: string,
  visitorName: string,
  keepResponseId: number,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!visitorIp || !visitorName) return 0; // 缺 IP 或姓名时不做任何清理,避免误删他人记录
  const rows = await db.select({ id: responses.id }).from(responses)
    .where(and(
      eq(responses.questionnaireId, questionnaireId),
      eq(responses.visitorIp, visitorIp),
      eq(responses.visitorName, visitorName),
      eq(responses.status, "in_progress"),
    ));
  const staleIds = rows.map(r => r.id).filter(id => id !== keepResponseId);
  for (const id of staleIds) {
    await db.delete(answers).where(eq(answers.responseId, id));
    await db.delete(responses).where(eq(responses.id, id));
  }
  return staleIds.length;
}

/**
 * Answer operations
 */
export async function createAnswers(answerList: (typeof answers.$inferInsert)[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return db.insert(answers).values(answerList);
}

export async function savePublicAnswerSnapshot(responseId: number, visitorToken: string | undefined, answerList: (typeof answers.$inferInsert)[], submit: boolean) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async transaction => {
    const [response] = await transaction.select().from(responses).where(eq(responses.id, responseId)).for("update");
    if (!response || (response.visitorToken && response.visitorToken !== visitorToken)) throw new TRPCError({ code: "FORBIDDEN" });
    if (response.subQuestionnaireIndex != null || response.status !== "in_progress") throw new TRPCError({ code: "BAD_REQUEST", message: "答卷已提交或需要通过子问卷保存流程" });
    await transaction.delete(answers).where(eq(answers.responseId, responseId));
    if (answerList.length) await transaction.insert(answers).values(answerList.map(answer => ({ ...answer, responseId })));
    if (submit) await transaction.update(responses).set({ status: "submitted", submittedAt: new Date() }).where(eq(responses.id, responseId));
    return { success: true, saved: answerList.length };
  });
}

export async function submitAuthenticatedAnswers(responseId: number, userId: number, answerList: { questionId: number; answerContent: string }[]) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async transaction => {
    const [response] = await transaction.select().from(responses)
      .where(eq(responses.id, responseId)).for("update");
    if (!response || response.userId !== userId) throw new TRPCError({ code: "FORBIDDEN" });
    if (response.status !== "in_progress") throw new TRPCError({ code: "BAD_REQUEST", message: "答卷已提交，请联系管理员删除后重新填写" });
    await transaction.delete(answers).where(eq(answers.responseId, responseId));
    if (answerList.length) await transaction.insert(answers).values(answerList.map(answer => ({ ...answer, responseId })));
    await transaction.update(responses).set({ status: "submitted", submittedAt: new Date() })
      .where(eq(responses.id, responseId));
  });
}

export async function getAnswersByResponse(responseId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(answers)
    .where(eq(answers.responseId, responseId))
    .orderBy(answers.createdAt);
}

// 清空指定 response 已保存的所有 answers。
// 用于"中途保存进度"和"最终提交前先清空"这两种 upsert 语义:
// 每次保存/提交都先删后插,保证 answers 不会因中途保存 + 最终提交而出现重复行。
export async function deleteAnswersByResponse(responseId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(answers).where(eq(answers.responseId, responseId));
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
type DatabaseTransaction = Parameters<Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]>[0];

async function recalculateQuestionnaireStats(transaction: DatabaseTransaction, questionnaireId: number) {
  const rows = await transaction.select({ status: responses.status, totalScore: responses.totalScore })
    .from(responses).where(eq(responses.questionnaireId, questionnaireId));
  const summary = summarizeResponses(rows);
  const values = {
    totalResponses: summary.totalResponses,
    averageScore: summary.averageScore?.toFixed(2) ?? null,
    highestScore: summary.highestScore?.toFixed(2) ?? null,
    lowestScore: summary.lowestScore?.toFixed(2) ?? null,
    completionRate: summary.completionRate.toFixed(2),
    lastUpdated: new Date(),
  };
  await transaction.insert(questionnaireStats).values({ questionnaireId, ...values })
    .onDuplicateKeyUpdate({ set: values });
  const [stats] = await transaction.select().from(questionnaireStats)
    .where(eq(questionnaireStats.questionnaireId, questionnaireId));
  return stats;
}

export async function getOrCreateStats(questionnaireId: number) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async transaction => {
    const [questionnaire] = await transaction.select({ id: questionnaires.id }).from(questionnaires)
      .where(eq(questionnaires.id, questionnaireId)).for("update");
    if (!questionnaire) throw new TRPCError({ code: "NOT_FOUND" });
    return recalculateQuestionnaireStats(transaction, questionnaireId);
  });
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
  
  return withDimensionEdit(dimension.questionnaireId, transaction => transaction.insert(evaluationDimensions).values(dimension));
}

async function withDimensionEdit<Result>(questionnaireId: number, action: (transaction: Parameters<Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]>[0]) => Promise<Result>) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async transaction => {
    const [questionnaire] = await transaction.select().from(questionnaires).where(eq(questionnaires.id, questionnaireId)).for("update");
    const [response] = await transaction.select({ id: responses.id }).from(responses).where(eq(responses.questionnaireId, questionnaireId)).limit(1);
    if (!questionnaire || questionnaire.status === "published" || response) throw new TRPCError({ code: "BAD_REQUEST", message: "已发布或已有答卷的问卷不能修改评分维度，请先取消发布；已有答卷请复制问卷" });
    return action(transaction);
  });
}

export async function createEvaluationDimensions(dimensions: InsertEvaluationDimension[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (dimensions.length === 0) return;

  const questionnaireId = dimensions[0].questionnaireId;
  if (dimensions.some(dimension => dimension.questionnaireId !== questionnaireId)) throw new Error("评分维度必须属于同一问卷");
  return withDimensionEdit(questionnaireId, transaction => transaction.insert(evaluationDimensions).values(dimensions));
}

export async function getEvaluationDimensionsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(evaluationDimensions)
    .where(eq(evaluationDimensions.questionnaireId, questionnaireId))
    .orderBy(evaluationDimensions.orderIndex);
}

export async function getEvaluationDimensionById(id: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(evaluationDimensions)
    .where(eq(evaluationDimensions.id, id))
    .limit(1);
  return result[0];
}

export async function updateEvaluationDimension(id: number, updates: Partial<InsertEvaluationDimension>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const dimension = await getEvaluationDimensionById(id);
  if (!dimension) throw new TRPCError({ code: "NOT_FOUND" });
  if (updates.questionnaireId !== undefined && updates.questionnaireId !== dimension.questionnaireId) throw new TRPCError({ code: "BAD_REQUEST" });
  return withDimensionEdit(dimension.questionnaireId, transaction => transaction.update(evaluationDimensions)
    .set(updates)
    .where(eq(evaluationDimensions.id, id)));
}

export async function deleteEvaluationDimension(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const dimension = await getEvaluationDimensionById(id);
  if (!dimension) throw new TRPCError({ code: "NOT_FOUND" });
  return withDimensionEdit(dimension.questionnaireId, transaction => transaction.delete(evaluationDimensions)
    .where(eq(evaluationDimensions.id, id)));
}

// 删除某问卷的全部评分维度(改评分标准重新解析维度前调用)。
export async function deleteEvaluationDimensionsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return withDimensionEdit(questionnaireId, transaction => transaction.delete(evaluationDimensions)
    .where(eq(evaluationDimensions.questionnaireId, questionnaireId)));
}

/**
 * 盲测音频编辑相关操作
 * 说明:音频(audioFiles)与问卷(questionnaires)之间没有直接外键,
 * 而是通过盲测配对(blindTestPairs)的 left/right 关联。
 * 因此"某问卷用到的音频"需要从配对表反查并去重。
 */

// 取某问卷用到的全部音频(按 audioFileId 去重,保留稳定顺序)。
// 注意:默认排除 modelName='__reference__' 的参考音频(音色相似度维度专用),
// 若需拿到参考音频(如维度校验/复制问卷),显式传 includeReference=true。
export async function getAudioFilesByQuestionnaire(
  questionnaireId: number,
  options?: { includeReference?: boolean }
) {
  const db = await getDb();
  if (!db) return [] as AudioFile[];

  // 音频现在直接归属问卷(audioFiles.questionnaireId),不再依赖配对表反查,
  // 这样"已上传但尚未生成配对"的音频也能被列出与设置组别。
  const rows = await db.select().from(audioFiles)
    .where(eq(audioFiles.questionnaireId, questionnaireId))
    .orderBy(audioFiles.id);
  if (options?.includeReference) return rows;
  return rows.filter(r => r.modelName !== "__reference__");
}

// 删除某问卷的全部盲测配对(重建配对前调用)。
export async function deleteBlindTestPairsByQuestionnaire(questionnaireId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async transaction => {
    await lockMutableQuestionnaire(transaction, questionnaireId);
    return transaction.delete(blindTestPairs).where(eq(blindTestPairs.questionnaireId, questionnaireId));
  });
}

// 删除单个音频记录(仅删记录,OSS 对象保留,避免误删共享文件)。
export async function deleteAudioFile(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async transaction => {
    const [audio] = await transaction.select().from(audioFiles).where(eq(audioFiles.id, id));
    await lockMutableQuestionnaire(transaction, audio?.questionnaireId);
    return transaction.delete(audioFiles).where(eq(audioFiles.id, id));
  });
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
  return db.transaction(async transaction => {
  await lockMutableQuestionnaire(transaction, questionnaireId);
  const respRows = await transaction.select({ id: responses.id }).from(responses)
    .where(eq(responses.questionnaireId, questionnaireId));
  for (const r of respRows) {
    await transaction.delete(answers).where(eq(answers.responseId, r.id));
  }
  await transaction.delete(responses).where(eq(responses.questionnaireId, questionnaireId));
  await transaction.delete(questionnaireStats).where(eq(questionnaireStats.questionnaireId, questionnaireId));
  });
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
