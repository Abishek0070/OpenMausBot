import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { rememberConversation } from "../../src/lib/last-conversation";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
setAnalyticsEnabled(false);
if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
// The launcher names the bot to open on, because a fresh fixture would otherwise open on MausBot.
const resume = new URLSearchParams(location.search).get("resume");
if (resume) rememberConversation(resume);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
