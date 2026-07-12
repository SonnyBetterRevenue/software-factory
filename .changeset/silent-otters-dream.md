---
"@ai-hero/sandcastle": patch
---

Add committed `FACTORY_OPERATOR` and `FACTORY_WORKER` engine specs (`FactoryEngineSpec`) to `factory-policy`, replacing the hardcoded single-engine assumption. `FACTORY_MODEL`, `FACTORY_EFFORT`, and `FACTORY_CODEX_AUTH_ENV` remain as aliases derived from `FACTORY_WORKER` so existing consumers are unaffected.
