import "./styles/tokens.css";
import "./styles/shell.css";
import { bootstrapApp } from "./app/controller";

try {
  bootstrapApp();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#f87171">TradePanel failed to start:\n${message}</pre>`;
}
