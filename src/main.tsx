import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { startSession } from "@/lib/server";
import "@/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// Media is fetched by <video> and <img> elements, which cannot send the token
// header, so the token is traded for a session cookie before anything renders.
// A server that is down must not stop the app from rendering — recording works
// without it — so a failure here only means media will not load yet.
void startSession().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
