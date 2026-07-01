import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { Loader2, Music, CheckCircle2, BarChart3 } from "lucide-react";
import { getLoginUrl } from "@/const";

export default function Home() {
  const { user, loading, logout } = useAuth();
  const [, setLocation] = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin w-8 h-8" />
      </div>
    );
  }

  // If user is logged in, redirect to appropriate dashboard
  if (user) {
    if (user.role === "admin") {
      setLocation("/admin/dashboard");
    } else {
      setLocation("/user/dashboard");
    }
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100">
      {/* Navigation */}
      <nav className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Music className="w-6 h-6 text-blue-600" />
            <span className="text-xl font-semibold text-slate-900">AudioEval</span>
          </div>
          <a href={getLoginUrl()} className="text-sm font-medium text-blue-600 hover:text-blue-700">
            登录
          </a>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
        <div className="text-center space-y-8">
          <div className="space-y-4">
            <h1 className="text-5xl sm:text-6xl font-bold text-slate-900 tracking-tight">
              AI 音频测评平台
            </h1>
            <p className="text-xl text-slate-600 max-w-2xl mx-auto">
              智能化的音频评估系统，支持自动生成问卷、AI 评分和详细反馈。为教育、培训和评估提供优雅的解决方案。
            </p>
          </div>

          <div className="flex gap-4 justify-center pt-4">
            <a href={getLoginUrl()}>
              <Button size="lg" className="bg-blue-600 hover:bg-blue-700 text-white px-8">
                开始使用
              </Button>
            </a>
            <Button size="lg" variant="outline" className="px-8">
              了解更多
            </Button>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid md:grid-cols-3 gap-8">
          <div className="group rounded-lg border border-slate-200 bg-white p-8 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center mb-4 group-hover:bg-blue-600 group-hover:text-white transition-colors">
              <Music className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">音频上传与管理</h3>
            <p className="text-slate-600">
              支持 MP3、WAV、M4A 等多种格式，自动转写为文字，便捷管理音频资源库。
            </p>
          </div>

          <div className="group rounded-lg border border-slate-200 bg-white p-8 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center mb-4 group-hover:bg-purple-600 group-hover:text-white transition-colors">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">AI 自动出题</h3>
            <p className="text-slate-600">
              基于音频内容和测评标准，AI 智能生成单选、多选、主观题等多种题型。
            </p>
          </div>

          <div className="group rounded-lg border border-slate-200 bg-white p-8 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-lg bg-green-100 text-green-600 flex items-center justify-center mb-4 group-hover:bg-green-600 group-hover:text-white transition-colors">
              <BarChart3 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">智能评分与反馈</h3>
            <p className="text-slate-600">
              AI 自动评分，生成个性化评语和改进建议，支持详细的统计分析。
            </p>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 p-12 text-center text-white">
          <h2 className="text-3xl font-bold mb-4">准备好开始了吗？</h2>
          <p className="text-blue-100 mb-8 max-w-2xl mx-auto">
            加入数千名教育工作者和培训师，使用 AudioEval 提升评估效率。
          </p>
          <a href={getLoginUrl()}>
            <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50 px-8">
              立即登录
            </Button>
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white mt-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-slate-600">
          <p>&copy; 2026 AudioEval. 所有权利保留。</p>
        </div>
      </footer>
    </div>
  );
}
