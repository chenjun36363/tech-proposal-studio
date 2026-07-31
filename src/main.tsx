import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./core/theme";
import "./index.css";
import "./features/knowledge/knowledge.css";
import "./features/inspector/inspector.css";
import "./agent/styles/agent.css";
import "./agent/styles/conversation.css";
import "./agent/styles/draft-review.css";
import "katex/dist/katex.min.css";
import "./features/settings/memory-settings.css";

initTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
