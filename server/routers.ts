import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure } from "./_core/trpc";
import { z } from "zod";
import { storagePut } from "./storage";
import { transcribeAudio } from "./_core/voiceTranscription";
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

// 根据一组音频(含 modelName)生成盲测配对数据(左右已随机、整体已打乱顺序)。
// 规则:按 modelName 分组保持顺序 -> 每两个模型按相同序号一一配对 ->
// 随机左右位置消除位置偏见 -> Fisher-Yates 打乱展示顺序。
// upload 首次上传与后续音频编辑(增删换)重建配对时共用此逻辑,保证行为一致。
export function buildBlindTestPairs(
  questionnaireId: number,
  audios: { audioFileId: number; modelName: string }[]
): { questionnaireId: number; leftAudioFileId: number; rightAudioFileId: number; pairIndex: number }[] {
  const groups = new Map<string, { audioFileId: number }[]>();
  for (const a of audios) {
    if (!groups.has(a.modelName)) groups.set(a.modelName, []);
    groups.get(a.modelName)!.push({ audioFileId: a.audioFileId });
  }
  const modelNames = Array.from(groups.keys());

  const rawPairs: { leftId: number; rightId: number }[] = [];
  for (let m = 0; m < modelNames.length; m++) {
    for (let n = m + 1; n < modelNames.length; n++) {
      const listA = groups.get(modelNames[m])!;
      const listB = groups.get(modelNames[n])!;
      const count = Math.min(listA.length, listB.length);
      for (let k = 0; k < count; k++) {
        const swapSides = Math.random() > 0.5;
        rawPairs.push({
          leftId: swapSides ? listB[k].audioFileId : listA[k].audioFileId,
          rightId: swapSides ? listA[k].audioFileId : listB[k].audioFileId,
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

// 音频编辑(增/删)后重建某问卷的盲测配对:
// 取当前问卷音频 -> 删旧配对 -> 按新音频集重新生成配对。
// 由于旧配对与旧答案(answers.blindTestPairId)绑定,音频变化会让旧作答失去意义,
// 故先清空该问卷的旧作答与统计,避免答案指向已删除的配对造成数据错位。
// 音频编辑(增/删)后重建某问卷的盲测配对:
// 取当前问卷音频 -> 删旧配对 -> 按新音频集重新生成配对。
// 由于旧配对与旧答案(answers.blindTestPairId)绑定,音频变化会让旧作答失去意义,
// 故先清空该问卷的旧作答与统计,避免答案指向已删除的配对造成数据错位。
// extraAudios: 新增但尚未进入配对表的音频(addToQuestionnaire 时传入)。
async function rebuildQuestionnairePairs(
  questionnaireId: number,
  extraAudios: { audioFileId: number; modelName: string }[] = []
) {
  // 先在删除旧配对之前取出当前音频集(getAudioFilesByQuestionnaire 依赖配对反查)。
  const existing = await db.getAudioFilesByQuestionnaire(questionnaireId);

  await db.deleteResponsesByQuestionnaire(questionnaireId);
  await db.deleteBlindTestPairsByQuestionnaire(questionnaireId);

  const all = [
    ...existing.map(a => ({ audioFileId: a.id, modelName: a.modelName || "未命名模型" })),
    ...extraAudios,
  ];
  // 去重(以 audioFileId 为准)
  const seen = new Set<number>();
  const audios = all.filter(a => {
    if (seen.has(a.audioFileId)) return false;
    seen.add(a.audioFileId);
    return true;
  });

  if (audios.length < 2) return; // 不足两个音频无法配对,清空后留空即可

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
        })),
        evaluationCopywriting: z.string().min(10),
        scoringStandard: z.string().min(10),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const uploadedAudios: { audioFileId: number; fileUrl: string; modelName: string; transcription: string | null }[] = [];

          for (const audioInput of input.audios) {
            // Upload to S3
            const fileKey = `audio/${ctx.user.id}/${Date.now()}-${audioInput.fileName}`;
            const { url: fileUrl } = await storagePut(fileKey, audioInput.fileData, audioInput.mimeType);

            // Create audio file record
            const result = await db.createAudioFile({
              uploaderId: ctx.user.id,
              fileName: audioInput.fileName,
              fileKey,
              fileUrl,
              mimeType: audioInput.mimeType,
              fileSizeBytes: audioInput.fileSizeBytes,
              transcription: null,
              modelName: audioInput.modelName, // Save model name
            });

            const audioFileId = getInsertId(result);

            // 转写为可选增强,放到后台异步执行,不阻塞上传响应(避免每个文件都等
            // fetch 音频 + 调用 Whisper 造成上传巨慢)。失败仅记日志,不影响上传。
            void (async () => {
              try {
                const transcriptionResult = await transcribeAudio({ audioUrl: fileUrl });
                if ("text" in transcriptionResult) {
                  await db.updateAudioFile(audioFileId, { transcription: transcriptionResult.text });
                }
              } catch (err) {
                console.error(`Transcription failed for ${audioInput.fileName}:`, err);
              }
            })();

            uploadedAudios.push({ audioFileId, fileUrl, modelName: audioInput.modelName, transcription: null });
          }

          // Create a single questionnaire for this batch of audios
          const qResult = await db.createQuestionnaire({
            creatorId: ctx.user.id,
            title: input.title,
            description: "",
            evaluationCopywriting: input.evaluationCopywriting,
            scoringStandard: input.scoringStandard,
            status: "draft",
            audioFileId: null, // This questionnaire is for blind test, not a single audio
            audioUrl: null,
          });

          const questionnaireId = getInsertId(qResult);

          // 生成盲测配对(抽取为 buildBlindTestPairs helper,与音频编辑重建配对共用):
          // 按 modelName 分组保持顺序 -> 每两个模型按相同序号一一配对 ->
          // 随机左右位置消除位置偏见 -> 打乱展示顺序。
          const blindTestPairsData = buildBlindTestPairs(
            questionnaireId,
            uploadedAudios.map(a => ({ audioFileId: a.audioFileId, modelName: a.modelName }))
          );
          await db.createBlindTestPairs(blindTestPairsData);

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
            blindTestPairsCount: blindTestPairsData.length,
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
     * 向已有问卷新增音频,并重建盲测配对。
     * 若问卷已有作答记录,旧配对会��效,故一并清空旧作答(避免答案错位到不存在的配对)。
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
        })).min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // 上传新音频并落库
        const newAudios: { audioFileId: number; modelName: string }[] = [];
        for (const audioInput of input.audios) {
          const fileKey = `audio/${ctx.user.id}/${Date.now()}-${audioInput.fileName}`;
          const { url: fileUrl } = await storagePut(fileKey, audioInput.fileData, audioInput.mimeType);
          const result = await db.createAudioFile({
            uploaderId: ctx.user.id,
            fileName: audioInput.fileName,
            fileKey,
            fileUrl,
            mimeType: audioInput.mimeType,
            fileSizeBytes: audioInput.fileSizeBytes,
            transcription: null,
            modelName: audioInput.modelName,
          });
          const audioFileId = getInsertId(result);
          newAudios.push({ audioFileId, modelName: audioInput.modelName });
          void (async () => {
            try {
              const t = await transcribeAudio({ audioUrl: fileUrl });
              if ("text" in t) await db.updateAudioFile(audioFileId, { transcription: t.text });
            } catch (err) {
              console.error(`Transcription failed for ${audioInput.fileName}:`, err);
            }
          })();
        }

       await rebuildQuestionnairePairs(input.questionnaireId, newAudios);
        return { success: true };
      }),

    /**
     * 从问卷中移除一个音频(删除音频记录),并重建盲测配对。
     * 同样会清空旧作答以保证数据一致。
     */
    removeFromQuestionnaire: adminProcedure
      .input(z.object({ questionnaireId: z.number(), audioFileId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        await db.deleteAudioFile(input.audioFileId);
        await rebuildQuestionnairePairs(input.questionnaireId);
        return { success: true };
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
        return { success: true };
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

        const result = await db.createAnonymousResponse({
          questionnaireId: input.questionnaireId as number,
          visitorIp,
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
      .input(z.object({ questionnaireId: z.number() }))
      .query(async ({ input, ctx }) => {
        const questionnaire = await db.getQuestionnaireById(input.questionnaireId);
        if (!questionnaire || questionnaire.creatorId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        // 配对信息:pairId -> { left, right } 模型名
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

        // 收集所有作答的答案
        const responsesList = await db.getQuestionnaireResponses(input.questionnaireId);
        const allAnswers: any[] = [];
        for (const r of responsesList) {
          const ans = await db.getAnswersByResponse(r.id);
          allAnswers.push(...ans);
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
          totalResponses: responsesList.length,
          totalJudgments: allAnswers.filter(a => a.blindTestChoice).length,
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
