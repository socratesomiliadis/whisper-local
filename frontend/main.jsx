import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource-variable/geist";
import "./styles.css";

// The development page obtains the session token from the existing local app.
async function bootstrap() {
    if (!document.querySelector('meta[name="app-token"]')) {
        const response = await fetch("/session", { cache: "no-store" });
        const html = new DOMParser().parseFromString(
            await response.text(),
            "text/html",
        );
        const token = html.querySelector('meta[name="app-token"]');
        if (token) document.head.append(token);
    }
    createRoot(document.getElementById("root")).render(<App />);
}
bootstrap();
