import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registers `window`, `document`, etc. as globals so @testing-library/react
// has a DOM to render into under `bun test`. Preloaded via bunfig.toml — see
// apps/web/bunfig.toml. Scoped to apps/web only: the root bunfig.toml's
// preload is for apps/api's env vars and must not also register a DOM there.
GlobalRegistrator.register();
