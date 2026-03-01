# AGENTS.md

## Frontend Change Confirmation Rule (Required)

- For any request involving frontend/UI/UX/page/component/style/interaction changes, do not start implementation immediately.
- First return a `交互图样式` proposal (wireframe/layout/style direction; ASCII or Mermaid is acceptable) for user review.
- Include at minimum: `需求理解`, `交互图样式`, `关键交互`, `待确认项`.
- Wait for explicit user confirmation before editing frontend code.
- This rule applies even when the task also includes backend changes; gate the frontend portion behind confirmation.
- Only skip this step if the user explicitly says to skip the prototype/wireframe step and proceed directly.

## Backend Change Confirmation Rule (Required)

- For any request involving backend/API/service/database/schema/task/job/integration/business-logic changes, do not start implementation immediately.
- First return a `流程图` proposal (process flow; Mermaid or ASCII is acceptable) for user review.
- Include at minimum: `需求理解`, `流程图`, `关键流程`, `待确认项`.
- Wait for explicit user confirmation before editing backend code.
- This rule applies even when the task also includes frontend changes; gate the backend portion behind confirmation.
- Only skip this step if the user explicitly says to skip the flowchart step and proceed directly.
