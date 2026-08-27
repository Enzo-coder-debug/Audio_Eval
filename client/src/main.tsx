import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

// 上传类 mutation(音频 base64 体积大)必须走单请求 httpLink,不能被 httpBatchLink 合并——
// 合并后前端 Promise.all 起的 4 并发会被打包成 1 条大 body(4×~1MB),
// JDOS ingress 1MB 单请求上限直接把并发拍平,线上速度腰斩甚至更差。
// 其余小查询/mutation 继续走 httpBatchLink,减少页面初始化 RTT。
const isUploadPath = (op: { path: string }) => {
  const p = op.path;
  return (
    p === "questionnaires.addAudioToQuestionnaire" ||
    p === "questionnaires.createQuestionnaire" ||
    p === "questionnaires.uploadReferenceAudio"
  );
};

const commonFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: isUploadPath,
      // 上传:每个 mutation 独立一条 HTTP,前端 4 并发才能真并发
      true: httpLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch: commonFetch,
      }),
      // 其它:继续 batch,页面查询/小改动合并成 1 个请求
      false: httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch: commonFetch,
      }),
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
