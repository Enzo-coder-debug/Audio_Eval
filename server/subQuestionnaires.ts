import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { evaluationAnswersError, type EvaluationAnswerInput } from "../shared/scoring";
import { getDb } from "./db";
import {
  answers,
  audioFiles,
  blindTestPairs,
  evaluationDimensions,
  questionnaires,
  responses,
} from "../drizzle/schema";
import {
  buildSubQuestionnairePlan,
  readSubQuestionnairePlan,
  summarizeSubQuestionnaires,
} from "../shared/subQuestionnaires";

async function requireDatabase() {
  const database = await getDb();
  if (!database)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "数据库不可用",
    });
  return database;
}

export function assertNoSubQuestionnairePlan(questionnaire: {
  subQuestionnairePlan?: unknown;
}) {
  if (questionnaire.subQuestionnairePlan != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "已启用固定子问卷，不能修改音频、组别、配对或随机抽样设置；请先停用分组方案。已有答卷时请复制问卷后调整。",
    });
  }
}

async function loadPairGroups(
  database: Pick<Awaited<ReturnType<typeof requireDatabase>>, "select">,
  questionnaireId: number
) {
  const pairs = await database
    .select()
    .from(blindTestPairs)
    .where(eq(blindTestPairs.questionnaireId, questionnaireId));
  const audios = await database
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.questionnaireId, questionnaireId));
  const audioMap = new Map(audios.map(audio => [audio.id, audio]));
  const groups = new Map<string, number[]>();
  for (const pair of pairs) {
    const left = audioMap.get(pair.leftAudioFileId);
    const right = audioMap.get(pair.rightAudioFileId);
    const label = left?.groupLabel?.trim();
    if (
      !left ||
      !right ||
      !label ||
      label !== right.groupLabel?.trim() ||
      left.modelName === right.modelName ||
      left.modelName === "__reference__" ||
      right.modelName === "__reference__"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "配对与当前组别不一致，请先重新生成盲测配对",
      });
    }
    const ids = groups.get(label) ?? [];
    ids.push(pair.id);
    groups.set(label, ids);
  }
  return Array.from(groups).map(([label, pairIds]) => ({ label, pairIds }));
}

export async function getSubQuestionnaireDistribution(
  questionnaireId: number,
  creatorId: number
) {
  const database = await requireDatabase();
  const [questionnaire] = await database
    .select()
    .from(questionnaires)
    .where(eq(questionnaires.id, questionnaireId));
  if (!questionnaire || questionnaire.creatorId !== creatorId)
    throw new TRPCError({ code: "FORBIDDEN" });
  const rows = await database
    .select({
      subQuestionnaireIndex: responses.subQuestionnaireIndex,
      status: responses.status,
    })
    .from(responses)
    .where(eq(responses.questionnaireId, questionnaireId));
  const plan = readSubQuestionnairePlan(questionnaire.subQuestionnairePlan);
  const groups = await loadPairGroups(database, questionnaireId);
  return {
    enabled: !!plan,
    groupsPerForm: plan?.groupsPerForm ?? null,
    responseCount: rows.length,
    groupCount: groups.length,
    pairCount: groups.reduce((total, group) => total + group.pairIds.length, 0),
    forms: plan ? summarizeSubQuestionnaires(plan, rows) : [],
  };
}

export async function configureSubQuestionnaires(
  input: {
    questionnaireId: number;
    groupsPerForm: number;
    quota: number;
    enabled: boolean;
  },
  creatorId: number
) {
  const database = await requireDatabase();
  return database.transaction(async transaction => {
    const [questionnaire] = await transaction
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.id, input.questionnaireId))
      .for("update");
    if (!questionnaire || questionnaire.creatorId !== creatorId)
      throw new TRPCError({ code: "FORBIDDEN" });
    if (questionnaire.status === "published")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "请先下线问卷再调整发放方案",
      });
    const existing = await transaction
      .select({ id: responses.id })
      .from(responses)
      .where(eq(responses.questionnaireId, input.questionnaireId))
      .limit(1);
    if (existing.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "已有答卷，不能重新分组或停用方案；请复制问卷后配置",
      });
    const groups = input.enabled
      ? await loadPairGroups(transaction, input.questionnaireId)
      : [];
    if (
      input.enabled &&
      (groups.length === 0 ||
        !Number.isInteger(input.groupsPerForm) ||
        input.groupsPerForm < 1 ||
        input.groupsPerForm > 10000 ||
        Math.ceil(groups.length / input.groupsPerForm) > 100)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "请先生成有效配对，每张组别数为 1–10000 的整数，最多生成 100 张子问卷",
      });
    const plan = input.enabled
      ? buildSubQuestionnairePlan(groups, input.groupsPerForm, input.quota)
      : null;
    await transaction
      .update(questionnaires)
      .set({ subQuestionnairePlan: plan, sampleSize: null })
      .where(eq(questionnaires.id, input.questionnaireId));
    return { success: true };
  });
}

export async function allocateSubQuestionnaire(input: {
  questionnaireId: number;
  visitorToken: string;
  visitorName: string;
  visitorIp: string;
}) {
  if (input.visitorToken.length < 16 || input.visitorToken.length > 64)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "访客标识无效，请刷新后重试",
    });
  const database = await requireDatabase();
  return database.transaction(async transaction => {
    const [questionnaire] = await transaction
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.id, input.questionnaireId))
      .for("update");
    const now = new Date();
    if (!questionnaire || questionnaire.status !== "published")
      throw new TRPCError({ code: "NOT_FOUND", message: "问卷未发布" });
    if (
      (questionnaire.validFrom && questionnaire.validFrom > now) ||
      (questionnaire.validUntil && questionnaire.validUntil < now)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "当前不在问卷有效期内",
      });
    const plan = readSubQuestionnairePlan(questionnaire.subQuestionnairePlan);
    if (!plan)
      throw new TRPCError({
        code: "CONFLICT",
        message: "发放方案已变化，请刷新页面",
      });
    const rows = await transaction
      .select()
      .from(responses)
      .where(eq(responses.questionnaireId, input.questionnaireId));
    const existing = rows.find(
      row =>
        row.visitorToken === input.visitorToken &&
        row.visitorName === input.visitorName
    );
    if (existing) {
      if (existing.status !== "in_progress")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "您已提交过此问卷，无需重复领取",
        });
      const form = plan.forms.find(
        item => item.index === existing.subQuestionnaireIndex
      );
      if (!form)
        throw new TRPCError({
          code: "CONFLICT",
          message: "答卷的子问卷配置缺失，请联系管理员",
        });
      return { responseId: existing.id, form, resumed: true };
    }
    const available = summarizeSubQuestionnaires(plan, rows).filter(
      form => form.remaining > 0
    );
    if (!available.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "子问卷已全部领满，暂不接受新的答卷；已领取的答卷可以继续填写",
      });
    const selected = available[Math.floor(Math.random() * available.length)];
    const [result] = await transaction.insert(responses).values({
      ...input,
      status: "in_progress",
      sampledGroupLabels: selected.groupLabels,
      subQuestionnaireIndex: selected.index,
      startedAt: now,
    });
    return {
      responseId: result.insertId,
      form: plan.forms.find(form => form.index === selected.index)!,
      resumed: false,
    };
  });
}

export async function getAssignedSubQuestionnaire(
  questionnaireId: number,
  responseId: number,
  visitorToken?: string
) {
  const database = await requireDatabase();
  const [response] = await database
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.id, responseId),
        eq(responses.questionnaireId, questionnaireId)
      )
    );
  if (
    !response ||
    !visitorToken ||
    response.visitorToken !== visitorToken ||
    !response.subQuestionnaireIndex
  )
    throw new TRPCError({ code: "FORBIDDEN", message: "无法访问此子问卷" });
  const [questionnaire] = await database
    .select()
    .from(questionnaires)
    .where(eq(questionnaires.id, questionnaireId));
  const form = readSubQuestionnairePlan(
    questionnaire?.subQuestionnairePlan
  )?.forms.find(form => form.index === response.subQuestionnaireIndex);
  if (!form)
    throw new TRPCError({
      code: "CONFLICT",
      message: "子问卷配置缺失，请联系管理员",
    });
  return form;
}

export async function saveSubQuestionnaireAnswers(
  input: {
    responseId: number;
    visitorToken?: string;
    answers: EvaluationAnswerInput[];
  },
  submit: boolean
) {
  const database = await requireDatabase();
  return database.transaction(async transaction => {
    const [response] = await transaction
      .select()
      .from(responses)
      .where(eq(responses.id, input.responseId))
      .for("update");
    if (
      !response ||
      !response.questionnaireId ||
      !response.subQuestionnaireIndex ||
      !input.visitorToken ||
      response.visitorToken !== input.visitorToken
    )
      throw new TRPCError({ code: "FORBIDDEN" });
    if (response.status !== "in_progress")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "答卷已提交，无法再修改",
      });
    const [questionnaire] = await transaction
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.id, response.questionnaireId));
    const form = readSubQuestionnairePlan(
      questionnaire?.subQuestionnairePlan
    )?.forms.find(item => item.index === response.subQuestionnaireIndex);
    if (!form)
      throw new TRPCError({ code: "CONFLICT", message: "子问卷配置缺失" });
    const groups = await loadPairGroups(transaction, response.questionnaireId);
    const labelsByPair = new Map(
      groups.flatMap(group =>
        group.pairIds.map(pairId => [pairId, group.label] as const)
      )
    );
    if (
      form.pairIds.some(
        pairId => !form.groupLabels.includes(labelsByPair.get(pairId) || "")
      )
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: "子问卷配对已变化，请联系管理员",
      });
    const dimensions = await transaction
      .select()
      .from(evaluationDimensions)
      .where(
        eq(evaluationDimensions.questionnaireId, response.questionnaireId)
      );
    const error = evaluationAnswersError(dimensions, form.pairIds.map(id => ({ id, groupLabel: labelsByPair.get(id) || "" })), input.answers, submit);
    if (error) throw new TRPCError({ code: "BAD_REQUEST", message: error });
    await transaction
      .delete(answers)
      .where(eq(answers.responseId, response.id));
    if (input.answers.length)
      await transaction.insert(answers).values(
        input.answers.map(answer => ({
          responseId: response.id,
          blindTestPairId: answer.blindTestPairId!,
          evaluationDimensionId: answer.evaluationDimensionId!,
          blindTestChoice: answer.blindTestChoice ?? null,
          audioEvaluation: answer.audioEvaluation ?? null,
        }))
      );
    if (submit)
      await transaction
        .update(responses)
        .set({ status: "submitted", submittedAt: new Date() })
        .where(eq(responses.id, response.id));
    return { success: true, saved: input.answers.length };
  });
}
