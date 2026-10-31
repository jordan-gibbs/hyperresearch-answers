# Hyperresearch Answers

Use these tools when the user needs a fact that should be sourced: a statistic, a regulation, a company filing detail, an API limit, a date.

- `ask`: one factual question per call. Returns a short answer with the quotes and URLs that support it, or `not_found` when nothing supports an answer. Report `not_found` honestly; don't guess. If it returns an id instead of an answer, call `get_answer` with that id.
- `get_answer`: free; collects a pending answer by id.
- `search`: when you want to read the sources yourself. Returns ranked sources with verbatim passages, no summary.

Each `ask` and `search` call is charged to the user's prepaid Hyperresearch balance, and the result shows the charge. Don't loop many calls for one question.
