import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Music, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast.error("请输入用户名和密码");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        toast.error(data.error || "登录失败");
        return;
      }
      toast.success("登录成功");
      // 刷新以重新拉取登录态,Home 会据角色跳转到管理后台。
      window.location.href = "/admin/dashboard";
    } catch (err) {
      console.error(err);
      toast.error("登录请求失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <Music className="w-6 h-6 text-blue-600" />
          <span className="text-xl font-semibold text-slate-900">AudioEval 管理登录</span>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="管理员用户名"
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "登录"}
          </Button>
        </form>
        <p className="text-xs text-slate-400 text-center mt-4">
          答卷人无需登录,请使用管理员分发的问卷链接参与测评。
        </p>
      </div>
    </div>
  );
}