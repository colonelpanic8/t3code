import ReactDOM from "react-dom/client";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../index.css";

import { ThreadReplayPlayground } from "./ThreadReplayPlayground";

// No StrictMode: its intentional double-rendering would skew every
// measurement this page exists to take.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ThreadReplayPlayground />,
);
