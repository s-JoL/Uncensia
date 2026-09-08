import "./legacy-storage.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./app.tsx";
import { language } from "./i18n.tsx";
import { ThemeProvider, ToastHost } from "./ui.tsx";

document.documentElement.lang = language();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastHost>
        <App />
      </ToastHost>
    </ThemeProvider>
  </StrictMode>,
);
