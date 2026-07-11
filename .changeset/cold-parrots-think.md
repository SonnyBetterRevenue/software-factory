---
"@ai-hero/sandcastle": patch
---

Keep terminal `result` events out of visible-progress detection so visible inactivity still times out unless the agent emits externally visible text, tool activity, or a completion signal.
