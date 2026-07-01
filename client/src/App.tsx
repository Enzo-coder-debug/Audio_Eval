import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AdminDashboard from "./pages/AdminDashboard";
import AdminQuestionnaireDetail from "./pages/AdminQuestionnaireDetail";
import UserDashboard from "./pages/UserDashboard";
import QuestionnaireDetail from "./pages/QuestionnaireDetail";
import AnswerQuestionnaire from "./pages/AnswerQuestionnaire";
import ResponseDetail from "./pages/ResponseDetail";
import PublicQuestionnaire from "./pages/PublicQuestionnaire";
import QuestionnaireAnalytics from "./pages/QuestionnaireAnalytics";
import AdminLogin from "./pages/AdminLogin";
import { useAuth } from "./_core/hooks/useAuth";
import { Spinner } from "@/components/ui/spinner";

function Router() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/" component={Home} />
      {/* Public questionnaire share link */}
      <Route path="/q/:shareToken" component={PublicQuestionnaire} />
      {/* Admin login (no auth required) */}
      <Route path="/admin/login" component={AdminLogin} />
      {/* Admin routes */}
      {user?.role === "admin" && (
        <>
          <Route path={"/admin/dashboard"} component={AdminDashboard} />
      <Route path={"/admin/questionnaire/:id"} component={AdminQuestionnaireDetail} />
      <Route path="/admin/questionnaire/:id/analytics" component={QuestionnaireAnalytics} />
        </>
      )}
      {/* User routes */}
      {user && user.role !== "admin" && (
        <>
          <Route path="/user/dashboard" component={UserDashboard} />
          <Route path="/user/questionnaire/:id" component={QuestionnaireDetail} />
          <Route path="/user/questionnaire/:id/answer/:responseId" component={AnswerQuestionnaire} />
          <Route path="/user/response/:id" component={ResponseDetail} />
        </>
      )}
      <Route path="/404" component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
