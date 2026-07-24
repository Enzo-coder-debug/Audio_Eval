import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure } from "./_core/trpc";
import { z } from "zod";
import { storagePut, buildAudioObjectKey } from "./storage";
import { invokeLLM } from "./_core/llm";
import * as db from "./db";
import { TRPCError } from "@trpc/server";

// mysql2 驱动下 drizzle 的 insert 返回 [ResultSetHeader, ...],insertId 在 result[0];
// 兼容直接挂在对象上的情况,统一安全取值。
function getInsertId(result: unknown): number {
  if (Array.isArray(result)) {
    return Number((result[0] as { insertId?: number })?.insertId);
  }
  return Number((result as { insertId?: number })?.insertId);
}

// 从自由文本的"评分标准"中自动解析出评分维度。
// 支持按换行/分号分隔;每条用冒号/破折号拆出 名称 与 描述。
// 解析不出有效维度时,回退为单个"整体效果"维度,保证盲测页可正常评分。
function parseScoringStandardToDimensions(
  text: string
): { dimensionName: string; description: string | null }[] {
  const segments = (text || "")
    .split(/[\n;；]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const dimensions: { dimensionName: string; description: string | null }[] = [];
  for (const seg of segments) {
    const cleaned = seg.replace(/^\s*(?:\d+[.、)]|[-•*])\s*/, "").trim();
    if (!cleaned) continue;
    const m = cleaned.match(/^(.+?)\s*[:：\-—]\s*(.+)$/);
    let name: string;
    let desc: string | null;
    if (m) {
      name = m[1].trim();
      desc = m[2].trim() || null;
    } else {
      name = cleaned;
      desc = null;
    }
    if (name.length > 50) {
      desc = cleaned;
      name = name.slice(0, 50);
    }
    if (name) dimensions.push({ dimensionName: name, description: desc });
  }

  if (dimensions.length === 0) {
    dimensions.push({ dimensionName: "整体效果", description: text?.trim() || null });
  }
  return dimensions;
}

// 根据一组音频(含 modelName 与 groupLabel)生成盲测配对数据(左右已随机、整体已打乱顺序)。
// 规则:按 groupLabel 分组(同一组=同一段文案/query) -> 组内不同 modelName 两两配对 ->
// 随机左右位置消除位置偏见 -> Fisher-Yates 打乱展示顺序。
// 组别为空的音频不参与配对;同组内同模型不配对。首次生成与重建配对共用此逻辑。
export function buildBlindTestPairs(
  questionnaireId: number,
  audios: { audioFileId: number; modelName: string; groupLabel?: string | null }[]
): { questionnaireId: number; leftAudioFileId: number; rightAudioFileId: number; pairIndex: number }[] {
  // 按 groupLabel 分组(空组别跳过)
  const groups = new Map<string, { audioFileId: number; modelName: string }[]>();
  for (const a of audios) {
    const label = (a.groupLabel || "").trim();
    if (!label) continue; // 未指定组别的音频不参与配对
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push({ audioFileId: a.audioFileId, modelName: a.modelName });
  }

  const rawPairs: { leftId: number; rightId: number }[] = [];
  // 组内不同模型两两配对
  for (const list of Array.from(groups.values())) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].modelName === list[j].modelName) continue; // 同模型不比较
        const swapSides = Math.random() > 0.5;
        rawPairs.push({
          leftId: swapSides ? list[j].audioFileId : list[i].audioFileId,
          rightId: swapSides ? list[i].audioFileId : list[j].audioFileId,
        });
      }
    }
  }

  for (let i = rawPairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rawPairs[i], rawPairs[j]] = [rawPairs[j], rawPairs[i]];
  }

  return rawPairs.map((pair, idx) => ({
    questionnaireId,
    leftAudioFileId: pair.leftId,
    rightAudioFileId: pair.rightId,
    pairIndex: idx,
  }));
}

// 重建某问卷的盲测配对:取当前问卷音频(已直接归属问卷) -> 清空旧作答与旧配对
// -> 按 groupLabel 分组重新生成配对。
// 由于旧配对与旧答案(answers.blindTestPairId)绑定,音频/组别变化会让旧作答失去意义,
// 故先清空该问卷的旧作答与统计,避免答案指向已删除的配对造成数据错位。
// 音频现直接归属问卷(audioFiles.questionnaireId),无需再传 extraAudios。
async function rebuildQuestionnairePairs(questionnaireId: number) {
  await db.deleteResponsesByQuestionnaire(questionnaireId);
  await db.deleteBlindTestPairsByQuestionnaire(questionnaireId);

  const existing = await db.getAudioFilesByQuestionnaire(questionnaireId);
  const audios = existing.map(a => ({
    audioFileId: a.id,
    modelName: a.modelName || "未命名模型",
    groupLabel: a.groupLabel,
  }));

  const pairs = buildBlindTestPairs(questionnaireId, audios);
  if (pairs.length > 0) await db.createBlindTestPairs(pairs);
}

// ---- 盲测统计学工具函数 ----

// Wilson score 置信区间:比正态近似更稳健,小样本也合理。
// successes 成功次数, n 总试验数, z 为置信水平对应分位(1.96≈95%)。返回 { lower, upper }。
function wilsonInterval(successes: number, n: number, z: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// 对数阶乘,避免大数溢出。
function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

// 二项分布 PMF:C(n,k) * p^k * (1-p)^(n-k)。
function binomPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  const logC = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

// 双侧二项检验(原假设 p=p0,通常 0.5):返回 p 值,越小说明差异越显著。
// 采用"概率不超过观测点的所有结果之和"的双侧定义。
function twoSidedBinomialTest(successes: number, n: number, p0: number): number {
  if (n === 0) return 1;
  const observed = binomPmf(successes, n, p0);
  const eps = 1e-9;
  let pValue = 0;
  for (let k = 0; k <= n; k++) {
    if (binomPmf(k, n, p0) <= observed + eps) {
      pValue += binomPmf(k, n, p0);
    }
  }
  return Math.min(1, pValue);
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  /**
   * Audio file management
   */
  audio: router({
    /**
     * Upload audio file (admin only)
     * Expects multipart form data with file, evaluationCopywriting, and scoringStandard
     */
    upload: adminProcedure
      .input(z.object({
        title: z.string().min(1, "请填写问卷名称"),
        audios: z.array(z.object({
          fileName: z.string(),
          fileData: z.instanceof(Uint8Array),
          mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/mp4"]),
          fileSizeBytes: z.number(),
          modelName: z.string().min(1), // New field for model name
          groupLabel: z.string().optional(), // 组别(可选),同组不同模型两两配对
        })),
        evaluationCopywriting: z.string(),
        scoringStandard: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          // 先创建问卷,再上传音频并直接归属到该问卷(audioFiles.questionnaireId)。
          const qResult = await db.createQuestionnaire({
            creatorId: ctx.user.id,
            title: input.title,
            description: "",
            evaluationCopywriting: input.evaluationCopywriting,
            scoringStandard: input.scoringStandard,
            status: "draft",
            audioFileId: null, // 盲测问卷,不绑定单个音频
            audioUrl: null,
          });
          const questionnaireId = getInsertId(qResult);

          const uploadedAudios: { audioFileId: number; fileUrl: string; modelName: string; transcription: string | null }[] = [];

          // 并行上传所有音频到 OSS(按日期+时间戳子文件夹归档),再顺序写库保持组别索引对应。
          // 之前是逐个 await 串行上传,N 个文件耗时≈N×单个,这里改为并发以显著提速。
          const uploadResults = await Promise.all(
            input.audios.map((audioInput) => {
              const fileKey = buildAudioObjectKey(ctx.user.id, audioInput.fileName);
              return storagePut(fileKey, audioInput.fileData, audioInput.mimeType).then((r) => ({
                fileKey,
                fileUrl: r.url,
              }));
            })
          );

          for (let i = 0; i < input.audios.length; i++) {
            const audioInput = input.audios[i];
            const { fileKey, fileUrl } = uploadResults[i];

            // 创建音频记录并直接归属问卷。groupLabel 可选,默认空(由管理员后续在音频管理里指定)。
            const result = await db.createAudioFile({
              uploaderId: ctx.user.id,
              fileName: audioInput.fileName,
              fileKey,
              fileUrl,
              mimeType: audioInput.mimeType,
              fileSizeBytes: audioInput.fileSizeBytes,
              transcription: null,
              modelName: audioInput.modelName,
              questionnaireId,
              groupLabel: audioInput.groupLabel?.trim() || null,
            });

            const audioFileId = getInsertId(result);
            uploadedAudios.push({ audioFileId, fileUrl, modelName: audioInput.modelName, transcription: null });
          }

          // 按需求取消"按序号自动配对":上传后不自动生成盲测配对。
          // 管理员�在音频管理页为音频指定组别(groupLabel),再手动点"生成盲测配对"。
          // 若上传时已带组别,则可直接生成一次;否则留空等待管理员配置。
          const hasAnyGroup = uploadedAudios.length > 0 &&
            input.audios.some(a => (a.groupLabel || "").trim().length > 0);
          let blindTestPairsCount = 0;
          if (hasAnyGroup) {
            const pairs = buildBlindTestPairs(
              questionnaireId,
              uploadedAudios.map((a, i) => ({
                audioFileId: a.audioFileId,
                modelName: a.modelName,
                groupLabel: input.audios[i].groupLabel,
              }))
            );
            if (pairs.length > 0) await db.createBlindTestPairs(pairs);
            blindTestPairsCount = pairs.length;
          }

          // 根据评分标准文本自动解析并写入评分维度,管理员后续可在详情页增删。
          const parsedDimensions = parseScoringStandardToDimensions(input.scoringStandard);
          await db.createEvaluationDimensions(
          parsedDimensions.map((d, idx) => ({
              questionnaireId,
              dimensionName: d.dimensionName,
              description: d.description,
              orderIndex: idx,
            }))
          );

          return {
            questionnaireId,
            uploadedAudios,
            blindTestPairsCount,
            dimensionsCount: parsedDimensions.length,
          };
        } catch (error) {
          // 打出尽可能完整的错误信息,便于定位 OSS/S3/DB 等底层错误(含 name/code/stack)
          const anyErr = error as any;
          const errorMsg =
            (anyErr && (anyErr.message || anyErr.Code || anyErr.name)) ||
            (typeof error === "string" ? error : JSON.stringify(anyErr));
          console.error("Audio upload failed:", {
            message: anyErr?.message,
            name: anyErr?.name,
            code: anyErr?.Code || anyErr?.code,
            httpStatusCode: anyErr?.$metadata?.httpStatusCode,
            stack: anyErr?.stack,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to upload audio files: ${errorMsg}`,
            cause: error,
          });
        }
      }),

    /**
     * 仅创建盲测问卷(含评分维度),不上传任何音频。
     * 用于前端"分片串行上传"流程:先建问卷拿到 id,再逐个音频调用 addToQuestionnaire,
     * 避免一次性把所有音频�进单个请求体导致网关(JDOS ingress 默认 1MB)返回 413。
     */
    createQuestionnaire: adminProcedure
      .input(z.object({
        title: z.string().min(1, "请填写问卷名称"),
        evaluationCopywriting: z.string(),
        scoringStandard: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const qResult = await db.createQuestionnaire({
          creatorId: ctx.user.id,
          title: input.title,
          description: "",
          evaluationCopywriting: input.evaluationCopywriting,
          scoringStandard: input.scoringStandard,
          status: "draft",
          audioFileId: null,
          audioUrl: null,
        });
        const questionnaireId = getInsertId(qResult);

        // 根据评分标准文本自动解析并写入评分维度,与 upload 接口保持一致。
        const parsedDimensions = parseScoringStandardToDimensions(input.scoringStandard);
        await db.createEvaluationDimensions(
          parsedDimensions.map((d, idx) => ({
            questionnaireId,
            dimensionName: d.dimensionName,
            description: d.description,
            orderIndex: idx,
          }))
        );

        return { questionnaireId, dimensionsCount: parsedDimensions.length };
      }),

    /**
     * Get audio files uploaded by current admin
     */
    list: adminProcedure.query(async ({ ctx }) => {
      return db.getAudioFilesByUploader(ctx.user.id);
    }),

    /**
     * Get audio file details
     */
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getAudioFileById(input.id);
      }),

    /**
     * 列出某问卷当前用到的音频(从盲测配对反查去重),供详情页音频管理使用。
     * 附带该问卷是否已有作答记录,前端据此提示"改音频将清空已有答卷"。
     */
    listByQuestionnaire: adminProcedure
      .input(z.object({ questionnaireId: z.number() }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const audios = await db.getAudioFilesByQuestionnaire(input.questionnaireId);
        const responseCount = await db.countResponsesByQuestionnaire(input.questionnaireId);
        return { audios, responseCount };
      }),

    /**
     * 向已有问卷新增音频(可带组别),仅落库归属问卷,不自动配对。
     * 管理员在音频管理页设置好组别后,再手动点"生成盲测配对"。
     */
    addToQuestionnaire: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        audios: z.array(z.object({
          fileName: z.string(),
          fileData: z.instanceof(Uint8Array),
          mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/mp4"]),
          fileSizeBytes: z.number(),
          modelName: z.string().min(1),
          groupLabel: z.string().optional(),
        })).min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // 上传新音频并直接归属该问卷(不自动配对)。并行上传到 OSS(按日期+时间戳子文件夹归档),再顺序写库。
        const uploadResults = await Promise.all(
          input.audios.map((audioInput) => {
            const fileKey = buildAudioObjectKey(ctx.user.id, audioInput.fileName);
            return storagePut(fileKey, audioInput.fileData, audioInput.mimeType).then((r) => ({
              fileKey,
              fileUrl: r.url,
            }));
          })
        );

        for (let i = 0; i < input.audios.length; i++) {
          const audioInput = input.audios[i];
          const { fileKey, fileUrl } = uploadResults[i];
          await db.createAudioFile({
            uploaderId: ctx.user.id,
            fileName: audioInput.fileName,
            fileKey,
            fileUrl,
            mimeType: audioInput.mimeType,
            fileSizeBytes: audioInput.fileSizeBytes,
            transcription: null,
            modelName: audioInput.modelName,
            questionnaireId: input.questionnaireId,
            groupLabel: audioInput.groupLabel?.trim() || null,
          });
        }
        return { success: true };
      }),

    /**
     * 从问卷中移除一批音频(仅删除音频记录),不自动重建配对。
     * 管理员移除/调整完成后,再手动点"生成盲测配对"统一重建。
     */
    removeFromQuestionnaire: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        audioFileIds: z.array(z.number()).min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        for (const audioFileId of input.audioFileIds) {
          await db.deleteAudioFile(audioFileId);
        }
        return { success: true };
      }),

    /**
     * 批量设置音频组别(groupLabel)。同组内不同模型两两配对。
     * 仅更新组别,不触发配对;管理员配置好后再手动点"生成盲测配对"。
     */
    updateGroupLabels: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        items: z.array(z.object({
          audioFileId: z.number(),
          groupLabel: z.string(),
        })).min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        for (const it of input.items) {
          await db.updateAudioFile(it.audioFileId, { groupLabel: it.groupLabel.trim() || null });
        }
        return { success: true };
      }),

    /**
     * 手动生成/重建盲测配对:按当前音频的组别(groupLabel),同组内不同模型两两配对。
     * 会清空该问卷的旧配对与旧作答(音频/组别变化后旧作答已失去意义)。
     */
    generatePairs: adminProcedure
      .input(z.object({ questionnaireId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        await rebuildQuestionnairePairs(input.questionnaireId);
        const pairs = await db.getBlindTestPairsByQuestionnaire(input.questionnaireId);
        return { success: true, pairsCount: pairs.length };
      }),
  }),

  /**
   * Questionnaire management
   */
  questionnaire: router({
    /**
     * Generate questions using AI
     */
    generateQuestions: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        transcription: z.string(),
        evaluationCopywriting: z.string(),
        scoringStandard: z.string(),
      }))
      .mutation(async ({ input }) => {
        try {
          const prompt = `Based on the following audio transcription and evaluation requirements, generate a structured questionnaire with a mix of single-choice, multiple-choice, and subjective questions.

Audio Transcription:
${input.transcription}

Evaluation Copywriting:
${input.evaluationCopywriting}

Scoring Standard:
${input.scoringStandard}

Generate a JSON response with the following structure:
{
  "questions": [
    {
      "type": "single_choice" | "multiple_choice" | "subjective",
      "text": "question text",
      "options": [{"id": "a", "text": "option text"}, ...] (only for choice questions),
      "correctAnswers": ["a", "b"] (only for choice questions),
      "scoringRubric": "scoring criteria" (only for subjective questions),
      "maxScore": 10
    }
  ]
}

Generate 5-8 questions total. Ensure they are relevant to the audio content and evaluation criteria.`;

          const response = await invokeLLM({
            messages: [
              { role: "system", content: "You are an expert at creating educational questionnaires." },
              { role: "user", content: prompt as string },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "questionnaire",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    questions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          text: { type: "string" },
                          options: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                id: { type: "string" },
                                text: { type: "string" },
                              },
                              required: ["id", "text"],
                            },
                          },
                          correctAnswers: { type: "array", items: { type: "string" } },
                          scoringRubric: { type: "string" },
                          maxScore: { type: "number" },
                        },
                        required: ["type", "text"],
                      },
                    },
                  },
                  required: ["questions"],
                  additionalProperties: false,
                },
              },
            },
          });

          const content = response.choices[0]?.message.content;
          if (!content) throw new Error("No response from LLM");

          const contentStr = typeof content === 'string' ? content : '';
          const parsed = JSON.parse(contentStr);
          const questionsList = parsed.questions.map((q: any, idx: number) => ({
            questionnaireId: input.questionnaireId,
            questionType: q.type,
            questionText: q.text,
            options: q.options || null,
            correctAnswers: q.correctAnswers || null,
            scoringRubric: q.scoringRubric || null,
            maxScore: q.maxScore || 10,
            orderIndex: idx,
          }));

          await db.createQuestions(questionsList);

          return {
            success: true,
            questionsCount: questionsList.length,
          };
        } catch (error) {
          console.error("Question generation failed:", error);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to generate questions",
          });
        }
      }),

    /**
     * Get questionnaire details with questions
     */
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.id);
        if (!questionnaire) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Check permission
        if (questionnaire.status === "draft" && questionnaire.creatorId !== ctx.user?.id && ctx.user?.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const questionsList = await db.getQuestionsByQuestionnaire(input.id);
        return {
          ...questionnaire,
          questions: questionsList,
        };
      }),

    /**
     * List questionnaires for admin
     */
    listAdmin: adminProcedure.query(async ({ ctx }) => {
      return db.getQuestionnairesByCreator(ctx.user.id);
    }),

    /**
     * List published questionnaires for users
     */
    listPublished: publicProcedure.query(async () => {
      return db.getPublishedQuestionnaires();
    }),

    /**
     * Get questionnaire by share token (public access)
     */
    getByShareToken: publicProcedure
      .input(z.object({ shareToken: z.string() }))
      .query(async ({ input }) => {
        const questionnaire = await db.getQuestionnaireByShareToken(input.shareToken);
        if (!questionnaire) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Get blind test pairs with audio info
        const pairs = await db.getBlindTestPairsByQuestionnaire(questionnaire.id);
        const pairsWithAudio = await Promise.all(
          pairs.map(async (pair) => {
            const leftAudio = await db.getAudioFileById(pair.leftAudioFileId);
            const rightAudio = await db.getAudioFileById(pair.rightAudioFileId);
            return {
              ...pair,
              leftAudio: leftAudio ? { id: leftAudio.id, fileUrl: leftAudio.fileUrl, fileName: leftAudio.fileName } : null,
              rightAudio: rightAudio ? { id: rightAudio.id, fileUrl: rightAudio.fileUrl, fileName: rightAudio.fileName } : null,
            };
          })
        );

        // Get evaluation dimensions
        const dimensions = await db.getEvaluationDimensionsByQuestionnaire(questionnaire.id);

        return {
          ...questionnaire,
          blindTestPairs: pairsWithAudio,
          dimensions,
        };
      }),

    /**
     * Update questionnaire
     */
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        evaluationCopywriting: z.string().optional(),
        scoringStandard: z.string().optional(),
        status: z.enum(["draft", "published", "offline"]).optional(),
        validFrom: z.date().optional(),
        validUntil: z.date().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.id);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const updates: any = {};
        if (input.title) updates.title = input.title;
        if (input.description) updates.description = input.description;
        if (input.evaluationCopywriting !== undefined) updates.evaluationCopywriting = input.evaluationCopywriting;
        if (input.scoringStandard !== undefined) updates.scoringStandard = input.scoringStandard;
        if (input.status) {
          updates.status = input.status;
          if (input.status === "published") {
            updates.publishedAt = new Date();
            // Generate share token if not exists
            if (!questionnaire.shareToken) {
              const { nanoid } = await import("nanoid");
              updates.shareToken = nanoid(12);
            }
          }
        }
        if (input.validFrom) updates.validFrom = input.validFrom;
        if (input.validUntil) updates.validUntil = input.validUntil;

        await db.updateQuestionnaire(input.id, updates);

        // 评分标准文本变更时,自动重新解析并同步评分维度(删旧建新)。
        // 说明:评分标准变更意味着评价口径改变,历史维度与已产生的作答均已失效,
        // 因此若已存在作答记录,一并清理,避免旧作答引用已删除的维度导致数据错位。
        let dimensionsUpdated = false;
        let dimensionsCount: number | undefined;
        if (
          input.scoringStandard !== undefined &&
          input.scoringStandard !== questionnaire.scoringStandard
        ) {
          const respCount = await db.countResponsesByQuestionnaire(input.id);
          if (respCount > 0) {
            await db.deleteResponsesByQuestionnaire(input.id);
          }
          await db.deleteEvaluationDimensionsByQuestionnaire(input.id);
          const parsedDimensions = parseScoringStandardToDimensions(input.scoringStandard);
          await db.createEvaluationDimensions(
            parsedDimensions.map((d, idx) => ({
              questionnaireId: input.id,
              dimensionName: d.dimensionName,
              description: d.description,
              orderIndex: idx,
            }))
          );
          dimensionsUpdated = true;
          dimensionsCount = parsedDimensions.length;
        }

        return { success: true, dimensionsUpdated, dimensionsCount };
      }),

    /**
     * Delete questionnaire and all associated data
     */
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.id);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        await db.deleteQuestionnaireCascade(input.id);
        return { success: true };
      }),

    /**
     * Duplicate an existing questionnaire (creates a draft copy).
     * 复制问卷基本信息、音频记录(共享OSS对象)、评分维度,并按组别重建盲测配对。
     */
    duplicate: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const source = await db.getQuestionnaireById(input.id);
        if (!source || source.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // 1. 复制问卷基本信息(status=draft, shareToken=null 避免唯一约束冲突)
        const qResult = await db.createQuestionnaire({
          creatorId: ctx.user.id,
          title: `${source.title}（副本）`,
          description: source.description ?? "",
          evaluationCopywriting: source.evaluationCopywriting,
          scoringStandard: source.scoringStandard,
          status: "draft",
          audioFileId: null,
          audioUrl: null,
          shareToken: null,
          validFrom: null,
          validUntil: null,
        });
        const newQuestionnaireId = getInsertId(qResult);

        // 2. 复制音频�录(新 questionnaireId, 保留 groupLabel/modelName/OSS 对象共享)
        const sourceAudios = await db.getAudioFilesByQuestionnaire(input.id);
        const copiedAudios: { audioFileId: number; modelName: string; groupLabel: string | null }[] = [];
        for (const a of sourceAudios) {
          const r = await db.createAudioFile({
            uploaderId: ctx.user.id,
            fileName: a.fileName,
            fileKey: a.fileKey,
            fileUrl: a.fileUrl,
            mimeType: a.mimeType,
            fileSizeBytes: a.fileSizeBytes,
            transcription: null,
            modelName: a.modelName,
            questionnaireId: newQuestionnaireId,
            groupLabel: a.groupLabel ?? null,
          });
          copiedAudios.push({
            audioFileId: getInsertId(r),
            modelName: a.modelName ?? "",
            groupLabel: a.groupLabel ?? null,
          });
        }

        // 3. 复制评分维度
        const sourceDimensions = await db.getEvaluationDimensionsByQuestionnaire(input.id);
        if (sourceDimensions.length > 0) {
          await db.createEvaluationDimensions(
            sourceDimensions.map((d, idx) => ({
              questionnaireId: newQuestionnaireId,
              dimensionName: d.dimensionName,
              description: d.description,
              weight: d.weight,
              maxScore: d.maxScore,
              orderIndex: d.orderIndex ?? idx,
            }))
          );
        }

        // 4. 按组别重建盲测配��
        let blindTestPairsCount = 0;
        const pairs = buildBlindTestPairs(newQuestionnaireId, copiedAudios);
        if (pairs.length > 0) {
          await db.createBlindTestPairs(pairs);
          blindTestPairsCount = pairs.length;
        }

        return {
          questionnaireId: newQuestionnaireId,
          audiosCount: copiedAudios.length,
          dimensionsCount: sourceDimensions.length,
          blindTestPairsCount,
        };
      }),
  }),

  /**
   * Evaluation dimension management
   */
  dimension: router({
    /**
     * Create evaluation dimension
     */
    create: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        dimensionName: z.string().min(1),
        description: z.string().optional(),
        weight: z.number().default(1),
        maxScore: z.number().default(10),
        orderIndex: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const result = await db.createEvaluationDimension({
          questionnaireId: input.questionnaireId,
          dimensionName: input.dimensionName,
          description: input.description || null,
          weight: String(input.weight) as any,
          maxScore: String(input.maxScore) as any,
          orderIndex: input.orderIndex,
        });

        return { success: true, dimensionId: getInsertId(result) };
      }),

    /**
     * Get evaluation dimensions for a questionnaire
     */
    list: publicProcedure
      .input(z.object({
        questionnaireId: z.number(),
      }))
      .query(async ({ input }) => {
        return await db.getEvaluationDimensionsByQuestionnaire(input.questionnaireId);
      }),

    /**
     * Update evaluation dimension
     */
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        dimensionName: z.string().optional(),
        description: z.string().optional(),
        weight: z.number().optional(),
        maxScore: z.number().optional(),
        orderIndex: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const updates: any = {};
        if (input.dimensionName) updates.dimensionName = input.dimensionName;
        if (input.description) updates.description = input.description;
        if (input.weight !== undefined) updates.weight = input.weight;
        if (input.maxScore !== undefined) updates.maxScore = input.maxScore;
        if (input.orderIndex !== undefined) updates.orderIndex = input.orderIndex;

        await db.updateEvaluationDimension(input.id, updates);
        return { success: true };
      }),

    /**
     * Delete evaluation dimension
     */
    delete: adminProcedure
      .input(z.object({
        id: z.number(),
      }))
      .mutation(async ({ input }) => {
        await db.deleteEvaluationDimension(input.id);
        return { success: true };
      }),
  }),

  /**
   * Response and answer management
   */
  response: router({
    /**
     * Start answering a questionnaire (public - anonymous)
     */
    startPublic: publicProcedure
      .input(z.object({
        questionnaireId: z.number(),
        visitorName: z.string().min(1, "请输入姓名"),
        visitorToken: z.string().optional(), // 浏览器级稳定标识,用于区分同 IP 的不同访客
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.status !== "published") {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        const now = new Date();
        if (questionnaire.validFrom && questionnaire.validFrom > now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Questionnaire not yet available" });
        }
        if (questionnaire.validUntil && questionnaire.validUntil < now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Questionnaire has expired" });
        }

        const visitorIp = ((ctx.req.headers["x-forwarded-for"] as string) || "").split(",")[0] || ctx.req.socket?.remoteAddress || "unknown";
        const visitorToken = input.visitorToken || "";

        // 复用同问卷、同浏览器 token 未提交的 in_progress 记录,避免同一个人每次进入都新建脏数据。
        // 按 token(而非 IP)匹配:同 IP 下的不同访客有各自不同的 token,不会互相复用。
        if (visitorToken) {
          const existing = await db.findInProgressResponse(input.questionnaireId, visitorToken);
          if (existing) {
            // 更新访客姓名(可能本次填写了新名字),继续沿用该记录
            await db.updateResponse(existing.id, { visitorName: input.visitorName });
            return { responseId: existing.id };
          }
        }

        const result = await db.createAnonymousResponse({
          questionnaireId: input.questionnaireId as number,
          visitorIp,
          visitorToken: visitorToken || null,
          visitorName: input.visitorName,
          status: "in_progress",
        });

        return {
          responseId: getInsertId(result),
        };
      }),

    /**
     * Start answering a questionnaire (authenticated)
     */
    start: protectedProcedure
      .input(z.object({ questionnaireId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        // Check if questionnaire exists and is published
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.status !== "published") {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Check validity period
        const now = new Date();
        if (questionnaire.validFrom && questionnaire.validFrom > now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Questionnaire not yet available" });
        }
        if (questionnaire.validUntil && questionnaire.validUntil < now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Questionnaire has expired" });
        }

        // Check if user already has a response
        let response = await db.getUserResponse(ctx.user.id, input.questionnaireId);
        if (!response) {
          const result = await db.createResponse({
            userId: ctx.user.id,
            questionnaireId: input.questionnaireId,
            status: "in_progress",
          });
          response = await db.getResponseById(getInsertId(result));
        }

        // Get questions
        const questions = await db.getQuestionsByQuestionnaire(input.questionnaireId);

        return {
          responseId: response?.id,
          questions,
        };
      }),

    /**
     * Submit answers (public - anonymous)
     */
    submitPublic: publicProcedure
      .input(z.object({
        responseId: z.number(),
        answers: z.array(z.object({
          questionId: z.number().optional(),
          evaluationDimensionId: z.number().optional(),
          blindTestPairId: z.number().optional(),
          answerContent: z.string().optional(),
          blindTestChoice: z.enum(["left_better", "same", "right_better"]).optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const response = await db.getResponseById(input.responseId);
        if (!response) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Create answer records
        const answersList = input.answers.map(a => ({
          responseId: input.responseId,
          questionId: a.questionId || null,
          evaluationDimensionId: a.evaluationDimensionId || null,
          blindTestPairId: a.blindTestPairId || null,
          answerContent: a.answerContent || null,
          blindTestChoice: a.blindTestChoice || null,
        }));

        await db.createAnswers(answersList);

        // Update response status
        await db.updateResponse(input.responseId, {
          status: "submitted",
          submittedAt: new Date(),
        });

        // 清理同问卷、同浏览器 token 的其他残留 in_progress 记录(避免"填写进展/答卷详情"出现脏数据)。
        // 按 visitorToken 而非 IP:避免误删同一 IP 下其他访客正在进行的答卷。
        if (response.visitorToken && response.questionnaireId) {
          await db.deleteStaleInProgressResponses(
            response.questionnaireId,
            response.visitorToken,
            input.responseId,
          );
        }

        return { success: true };
      }),

    /**
     * Submit answers (authenticated)
     */
    submit: protectedProcedure
      .input(z.object({
        responseId: z.number(),
        answers: z.array(z.object({
          questionId: z.number(),
          answerContent: z.string(),
        })),
      }))
      .mutation(async ({ input, ctx }) => {
        const response = await db.getResponseById(input.responseId);
        if (!response || response.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // Create answer records
        const answersList = input.answers.map(a => ({
          responseId: input.responseId,
          questionId: a.questionId,
          answerContent: a.answerContent,
        }));

        await db.createAnswers(answersList);

        // Update response status
        await db.updateResponse(input.responseId, {
          status: "submitted",
          submittedAt: new Date(),
        });

        // Trigger AI grading (can be async)
        gradeResponse(input.responseId).catch(err => console.error("Grading failed:", err));

        return { success: true };
      }),

    /**
     * Get response details
     */
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const response = await db.getResponseById(input.id);
        if (!response) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Check permission
        if (response.userId !== ctx.user?.id && ctx.user?.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const answersList = await db.getAnswersByResponse(input.id);
        return {
          ...response,
          answers: answersList,
        };
      }),

    /**
     * Get user's responses
     */
    listUser: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserResponses(ctx.user.id);
    }),

    /**
     * Get all responses for a questionnaire (admin only)
     */
    listQuestionnaire: adminProcedure
      .input(z.object({ questionnaireId: z.number() }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const responsesList = await db.getQuestionnaireResponses(input.questionnaireId);

        // 构建每个盲测配对的左右模型名映射,供前端把"左/右更好"翻译为具体模型的优劣。
        const pairs = await db.getBlindTestPairsByQuestionnaire(input.questionnaireId);
        const pairsInfo = await Promise.all(
          pairs.map(async (pair) => {
            const leftAudio = await db.getAudioFileById(pair.leftAudioFileId);
            const rightAudio = await db.getAudioFileById(pair.rightAudioFileId);
            return {
              id: pair.id,
              pairIndex: pair.pairIndex,
              leftModelName: leftAudio?.modelName || "左侧模型",
              rightModelName: rightAudio?.modelName || "右侧模型",
              leftFileName: leftAudio?.fileName || null,
              rightFileName: rightAudio?.fileName || null,
            };
          })
        );

        // Enrich with answers for each response
        const enriched = await Promise.all(
          responsesList.map(async (resp) => {
            const respAnswers = await db.getAnswersByResponse(resp.id);
            return { ...resp, answers: respAnswers };
          })
        );

        return { responses: enriched, pairsInfo };
      }),
  }),

  /**
   * Statistics
   */
  stats: router({
    /**
     * Get questionnaire statistics
     */
    get: protectedProcedure
      .input(z.object({ questionnaireId: z.number() }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Check permission
        if (questionnaire.creatorId !== ctx.user?.id && ctx.user?.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        return db.getOrCreateStats(input.questionnaireId);
      }),

    /**
     * 盲测聚合统计分析:把所有答卷的 blindTestChoice 按"模型对比 × 评分维度"聚合,
     * 计算 win/tie/loss、胜率、GSB 分数,并用 Wilson 置信区间 + 双侧二项检验
     * 给出差异显著性(置信度),用于自动化的模型优劣结论。
     */
    aggregate: adminProcedure
      .input(z.object({
        questionnaireId: z.number(),
        // 需要纳入分析的样本(答卷)id 列表。样本粒度为"测评人/每份提交的问卷"。
        // 传 undefined 表示全选(纳入全部已提交答卷);传具体数组则只统计选中的答卷。
        includeResponseIds: z.array(z.number()).optional(),
      }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // 配对信息:pairId -> { left, right } 模型名(用于把 left/right 选择映射到模型对比)。
        const pairs = await db.getBlindTestPairsByQuestionnaire(input.questionnaireId);
        const pairMeta = new Map<number, { left: string; right: string }>();
        for (const p of pairs) {
          const leftAudio = await db.getAudioFileById(p.leftAudioFileId);
          const rightAudio = await db.getAudioFileById(p.rightAudioFileId);
          pairMeta.set(p.id, {
            left: leftAudio?.modelName || "左侧模型",
            right: rightAudio?.modelName || "右侧模型",
         });
        }

        const dimensions = await db.getEvaluationDimensionsByQuestionnaire(input.questionnaireId);
        const dimNameMap = new Map<number, string>(dimensions.map(d => [d.id, d.dimensionName]));

        // 样本 = 每份已提交的答卷(测评人维度)。只纳入 submitted/graded 状态,过滤掉进行中/脏数据。
        const responsesList = (await db.getQuestionnaireResponses(input.questionnaireId))
          .filter(r => r.status === "submitted" || r.status === "graded");

        // 前端筛选面板用的样本列表(按答卷人),同时统计每份答卷的有效判断数。
        const answersByResponse = new Map<number, any[]>();
        for (const r of responsesList) {
          const ans = await db.getAnswersByResponse(r.id);
          answersByResponse.set(r.id, ans);
        }
        const responseSamples = responsesList.map(r => ({
          id: r.id,
          visitorName: r.visitorName || "匿名",
          submittedAt: r.submittedAt,
          judgmentCount: (answersByResponse.get(r.id) || []).filter((a: any) => a.blindTestChoice).length,
        }));

        // 选中集合:未传或空数组 => 全选(纳入全部)。否则只纳入选中的答卷。
        const includeSet = input.includeResponseIds && input.includeResponseIds.length > 0
          ? new Set(input.includeResponseIds)
          : null;

        // 收集被纳入分析的答卷的答案
        const allAnswers: any[] = [];
        let includedResponseCount = 0;
        for (const r of responsesList) {
          if (includeSet && !includeSet.has(r.id)) continue;
          includedResponseCount++;
          allAnswers.push(...(answersByResponse.get(r.id) || []));
        }

        // 聚合键:`${dimensionId}|${modelA}__VS__${modelB}`(modelA/B 按字典序规范化,消除左右差异)
        type Cell = { modelA: string; modelB: string; dimensionId: number; aWins: number; bWins: number; ties: number };
        const cells = new Map<string, Cell>();

        for (const a of allAnswers) {
          if (!a.blindTestPairId || !a.blindTestChoice) continue;
          const meta = pairMeta.get(a.blindTestPairId);
          if (!meta) continue;
          if (meta.left === meta.right) continue; // 同模型不比

          // 规范化:让 modelA 始终是字典序较小者,把 left/right 结果映射到 A/B 视角
          const [modelA, modelB] = meta.left < meta.right ? [meta.left, meta.right] : [meta.right, meta.left];
          const leftIsA = meta.left === modelA;
          const dimId = a.evaluationDimensionId ?? 0;
          const key = `${dimId}|${modelA}__VS__${modelB}`;
          if (!cells.has(key)) {
            cells.set(key, { modelA, modelB, dimensionId: dimId, aWins: 0, bWins: 0, ties: 0 });
          }
          const cell = cells.get(key)!;
          if (a.blindTestChoice === "same") {
            cell.ties++;
          } else {
            const leftWon = a.blindTestChoice === "left_better";
            const aWon = leftIsA ? leftWon : !leftWon;
            if (aWon) cell.aWins++;
            else cell.bWins++;
          }
        }

        // 生成统计结果
        const comparisons = Array.from(cells.values()).map(cell => {
          const total = cell.aWins + cell.bWins + cell.ties;
          const decisive = cell.aWins + cell.bWins; // 排除平局的有效对比数
          const aWinRate = total > 0 ? cell.aWins / total : 0;
          const bWinRate = total > 0 ? cell.bWins / total : 0;
          const tieRate = total > 0 ? cell.ties / total : 0;
          // GSB 分数:(win - loss) / total,范围 [-1,1],>0 表示 A 更优
          const gsbScore = total > 0 ? (cell.aWins - cell.bWins) / total : 0;

          // 置信度:仅看非平局的决定性对比,A 胜出比例的 Wilson 95% 区间 + 双侧二项检验
          const wilson = wilsonInterval(cell.aWins, decisive, 1.96);
          const pValue = twoSidedBinomialTest(cell.aWins, decisive, 0.5);
          const significant = decisive > 0 && pValue < 0.05;
          let winner: string | null = null;
          if (significant) winner = cell.aWins > cell.bWins ? cell.modelA : cell.modelB;

          return {
            dimensionId: cell.dimensionId,
            dimensionName: dimNameMap.get(cell.dimensionId) || (cell.dimensionId === 0 ? "整体" : `维度#${cell.dimensionId}`),
            modelA: cell.modelA,
            modelB: cell.modelB,
            aWins: cell.aWins,
            bWins: cell.bWins,
            ties: cell.ties,
            total,
            aWinRate,
            bWinRate,
            tieRate,
            gsbScore,
            confidenceLevel: decisive > 0 ? 1 - pValue : 0, // 置信度 = 1 - p 值
            pValue,
            wilsonLower: wilson.lower,
            wilsonUpper: wilson.upper,
            significant,
            winner,
          };
        });

        return {
          totalResponses: includedResponseCount,
          totalJudgments: allAnswers.filter(a => a.blindTestChoice).length,
          comparisons,
          responseSamples,
        };
      }),

    /**
     * 跨问卷聚合统计:选中多个问卷,把它们的 blindTestChoice 按"模型对比 × 评分维度名"
     * 跨问卷合并聚合。不同问卷的维度 id 不同,故按 dimensionName 归并;模型名跨问卷天然按名字对齐。
     * 计算方式与单问卷 aggregate 一致(GSB / Wilson / 双侧二项检验)。
     */
    aggregateMulti: adminProcedure
      .input(z.object({ questionnaireIds: z.array(z.number()).min(1) }))
      .query(async ({ input, ctx }) => {
        // 聚合键:`${dimensionName}|${modelA}__VS__${modelB}`(modelA/B 按字典序规范化)
        type Cell = { modelA: string; modelB: string; dimensionName: string; aWins: number; bWins: number; ties: number };
        const cells = new Map<string, Cell>();
        let totalResponses = 0;
        let totalJudgments = 0;
        const includedQuestionnaires: { id: number; title: string }[] = [];

        for (const qid of input.questionnaireIds) {
          const questionnaire = await db.getQuestionnaireById(qid);
          // 仅统计当前管理员自己的问卷,无权/不存在的静默跳过
          if (!questionnaire || questionnaire.creatorId !== ctx.user.id) continue;
          includedQuestionnaires.push({ id: questionnaire.id, title: questionnaire.title });

          const pairs = await db.getBlindTestPairsByQuestionnaire(qid);
          const pairMeta = new Map<number, { left: string; right: string }>();
          for (const p of pairs) {
            const leftAudio = await db.getAudioFileById(p.leftAudioFileId);
            const rightAudio = await db.getAudioFileById(p.rightAudioFileId);
            pairMeta.set(p.id, {
              left: leftAudio?.modelName || "左侧模型",
              right: rightAudio?.modelName || "右侧模型",
            });
          }

          const dimensions = await db.getEvaluationDimensionsByQuestionnaire(qid);
          const dimNameMap = new Map<number, string>(dimensions.map(d => [d.id, d.dimensionName]));

          const responsesList = await db.getQuestionnaireResponses(qid);
          totalResponses += responsesList.length;
          for (const r of responsesList) {
            const answers = await db.getAnswersByResponse(r.id);
            for (const a of answers) {
              if (!a.blindTestPairId || !a.blindTestChoice) continue;
              totalJudgments++;
              const meta = pairMeta.get(a.blindTestPairId);
              if (!meta || meta.left === meta.right) continue;

              const [modelA, modelB] = meta.left < meta.right ? [meta.left, meta.right] : [meta.right, meta.left];
              const leftIsA = meta.left === modelA;
              const dimName = a.evaluationDimensionId
                ? dimNameMap.get(a.evaluationDimensionId) || `维度#${a.evaluationDimensionId}`
                : "整体";
              const key = `${dimName}|${modelA}__VS__${modelB}`;
              if (!cells.has(key)) {
                cells.set(key, { modelA, modelB, dimensionName: dimName, aWins: 0, bWins: 0, ties: 0 });
              }
              const cell = cells.get(key)!;
              if (a.blindTestChoice === "same") {
                cell.ties++;
              } else {
                const leftWon = a.blindTestChoice === "left_better";
                const aWon = leftIsA ? leftWon : !leftWon;
                if (aWon) cell.aWins++;
                else cell.bWins++;
              }
            }
          }
        }

        const comparisons = Array.from(cells.values()).map(cell => {
          const total = cell.aWins + cell.bWins + cell.ties;
          const decisive = cell.aWins + cell.bWins;
          const aWinRate = total > 0 ? cell.aWins / total : 0;
          const bWinRate = total > 0 ? cell.bWins / total : 0;
          const tieRate = total > 0 ? cell.ties / total : 0;
          const gsbScore = total > 0 ? (cell.aWins - cell.bWins) / total : 0;
          const wilson = wilsonInterval(cell.aWins, decisive, 1.96);
          const pValue = twoSidedBinomialTest(cell.aWins, decisive, 0.5);
          const significant = decisive > 0 && pValue < 0.05;
          let winner: string | null = null;
          if (significant) winner = cell.aWins > cell.bWins ? cell.modelA : cell.modelB;

          return {
            dimensionId: 0,
            dimensionName: cell.dimensionName,
            modelA: cell.modelA,
            modelB: cell.modelB,
            aWins: cell.aWins,
            bWins: cell.bWins,
            ties: cell.ties,
            total,
            aWinRate,
            bWinRate,
            tieRate,
            gsbScore,
            confidenceLevel: decisive > 0 ? 1 - pValue : 0,
            pValue,
            wilsonLower: wilson.lower,
            wilsonUpper: wilson.upper,
            significant,
            winner,
          };
        });

        return {
          totalResponses,
          totalJudgments,
          includedQuestionnaires,
          comparisons,
        };
      }),
  }),
});

/**
 * Helper function to grade a response using AI
 */
async function gradeResponse(responseId: number) {
  try {
    const response = await db.getResponseById(responseId);
    if (!response) return;

    if (!response.questionnaireId) return;
    const questionnaire = await db.getQuestionnaireById(response.questionnaireId);
    if (!questionnaire) return;

    const questions = await db.getQuestionsByQuestionnaire(response.questionnaireId);
    const answers = await db.getAnswersByResponse(responseId);

    // Build grading prompt
    let totalScore = 0;
    let gradingResults = [];

    for (const answer of answers) {
      const question = questions.find(q => q.id === answer.questionId);
      if (!question) continue;

      if (question.questionType === "subjective") {
        // Grade subjective answer with AI
        const gradingPrompt = `Grade the following answer based on the scoring rubric.

Question: ${question.questionText}
Answer: ${answer.answerContent}
Scoring Rubric: ${question.scoringRubric}
Max Score: ${question.maxScore}

Provide a JSON response with:
{
  "score": <number between 0 and maxScore>,
  "feedback": "<brief feedback>"
}`;

        const gradingResponse = await invokeLLM({
          messages: [
            { role: "system", content: "You are an expert evaluator." },
            { role: "user", content: gradingPrompt as string },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "grading",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  feedback: { type: "string" },
                },
                required: ["score", "feedback"],
                additionalProperties: false,
              },
            },
          },
        });

        const gradingContent = gradingResponse.choices[0]?.message.content;
        const gradingStr = typeof gradingContent === 'string' ? gradingContent : '{}';
        const grading = JSON.parse(gradingStr);
        const gradingScore = Number(grading.score) || 0;
        totalScore += gradingScore;
        gradingResults.push({ answerId: answer.id, score: gradingScore, feedback: grading.feedback });

        // Update answer with score and feedback
        await db.updateAnswer(answer.id, {
          score: gradingScore.toString(),
          feedback: grading.feedback,
        });
      } else {
        // Auto-score choice questions
        const userAnswers = JSON.parse(answer.answerContent || '[]') as string[];
        const correctAnswers = (question.correctAnswers as string[]) || [];
        const isCorrect = JSON.stringify([...userAnswers].sort()) === JSON.stringify([...correctAnswers].sort());
        const score = isCorrect ? (Number(question.maxScore) || 10) : 0;

        totalScore += score;
        gradingResults.push({ answerId: answer.id, score, feedback: isCorrect ? "Correct" : "Incorrect" });

        await db.updateAnswer(answer.id, {
          score: score.toString(),
          feedback: isCorrect ? "Correct" : "Incorrect",
        });
      }
    }

    // Generate overall AI comments
    const maxPossibleScore = questions.reduce((sum, q) => sum + (Number(q.maxScore) || 10), 0);
    const commentsPrompt = `Based on the following evaluation results, provide a brief overall assessment and suggestions for improvement.

Questionnaire: ${questionnaire.title}
Total Score: ${totalScore}
Max Possible Score: ${maxPossibleScore}
Scoring Standard: ${questionnaire.scoringStandard}

Provide a JSON response with:
{
  "comments": "<brief overall assessment and suggestions>"
}`;

    const commentsResponse = await invokeLLM({
      messages: [
        { role: "system", content: "You are an expert evaluator providing constructive feedback." },
        { role: "user", content: commentsPrompt as string },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "comments",
          strict: true,
          schema: {
            type: "object",
            properties: {
              comments: { type: "string" },
            },
            required: ["comments"],
            additionalProperties: false,
          },
        },
      },
    });

    const commentsContentStr = typeof commentsResponse.choices[0]?.message.content === 'string' 
      ? commentsResponse.choices[0]?.message.content 
      : '{}';
    const comments = JSON.parse(commentsContentStr);

    // Update response with final score and comments
    await db.updateResponse(responseId, {
      totalScore: totalScore.toString(),
      aiComments: comments.comments,
      status: "graded",
      gradedAt: new Date(),
    });

    // Update questionnaire stats
    const stats = await db.getOrCreateStats(response.questionnaireId);
    const allResponses = await db.getQuestionnaireResponses(response.questionnaireId);
    const gradedResponses = allResponses.filter(r => r.status === "graded");

    if (gradedResponses.length > 0) {
      const scores = gradedResponses.map(r => Number(r.totalScore) || 0);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      const completionRate = (gradedResponses.length / allResponses.length) * 100;

      await db.updateStats(response.questionnaireId, {
        totalResponses: allResponses.length,
        averageScore: avgScore.toString(),
        highestScore: maxScore.toString(),
        lowestScore: minScore.toString(),
        completionRate: completionRate.toString(),
      });
    }
  } catch (error) {
    console.error("Failed to grade response:", error);
  }
}

export type AppRouter = typeof appRouter;
