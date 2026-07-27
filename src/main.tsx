import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./theme";
import "./index.css";
import "./features/knowledge/knowledge.css";
import "./features/inspector/inspector.css";
import "./agent.css";
import "./agent-conversation.css";
import "./agent-approval.css";
import "./agent-draft-review.css";
import "katex/dist/katex.min.css";
import "./memory-settings.css";

initTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
