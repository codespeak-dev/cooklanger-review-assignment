# Review data for the `diet-modes` branch

You are reviewing a feature branch of **cooklanger**, a terminal recipe manager.
An AI coding agent wrote the branch in a single session with a developer. While
the session ran, the developer's intent was pulled out of it as a short list of
**requirements**. Each requirement is linked to the message it came from and to
the code that implements it.

This repository has two branches:

| Branch | What it is |
| --- | --- |
| `master` | The base: cooklanger before the feature. |
| `diet-modes` | The feature: diet profiles, recipe checks and diet-aware remixes. `git diff master diet-modes` is the change under review. |

The review data sits in this `review/` folder, which is identical on both
branches and so never shows up in the diff:

| File | What it is |
| --- | --- |
| `session.json` | The conversation between the developer and the agent that produced the branch. |
| `requirements.json` | The requirements, linked to `session.json` and to the code on `diet-modes`. |

## `session.json`

```json
{
  "messages": [
    { "id": "m1", "role": "user", "text": "I want to add a new feature – diet modes. …" },
    { "id": "m2", "role": "tool", "text": "Rename session and survey remix and key bindings" },
    { "id": "m3", "role": "assistant", "text": "cooklanger is a local, single-machine app. …" }
  ]
}
```

Messages are in the order they happened.

| Field | Meaning |
| --- | --- |
| `id` | Stable id. Requirements point at messages by this id. |
| `role` | `user` is the developer. `assistant` is the agent. `tool` is a one-line summary of something the agent did, such as reading or editing a file or running tests. |
| `text` | The message itself. The agent sometimes asked multiple-choice questions. The questions and their options are an `assistant` message, and the developer's picks follow as a `user` message, one `"question" → answer` per line. |

## `requirements.json`

```json
{
  "requirements": [
    {
      "id": "11d580ef5101",
      "change": "edited",
      "statement": "Remix mode shall send the selected recipe, the typed note and the active diet profile to the LLM, asking for …",
      "slots": {
        "scope": "remix mode",
        "preconditions": [],
        "verb": "send",
        "object": "the selected recipe, the typed note and the active diet profile to the LLM",
        "modifiers": ["asking for an adapted recipe that keeps to that diet"]
      },
      "previousStatement": "Remix mode shall send the selected recipe and the typed note to the LLM, under …",
      "previousSlots": {
        "scope": "remix mode",
        "preconditions": [],
        "verb": "send",
        "object": "the selected recipe and the typed note to the LLM",
        "modifiers": ["under a system prompt that asks it to adapt the recipe"]
      },
      "quote": "our remix mode can be tuned to produce the version of this recipe that will suite the diet",
      "source": { "messageId": "m1", "author": "user" },
      "code": [
        { "file": "src/remix.ts", "lines": [101, 132] },
        { "file": "src/browser.ts", "lines": [1036, 1050] }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable id of the requirement. An edited requirement keeps the id it had before the branch. |
| `change` | What the branch does to the requirement: `added` (new), `edited` (existed before and now says something different) or `removed` (existed before and no longer applies). |
| `statement` | The requirement as it stands after the branch. For `removed`, it is the requirement that was dropped. |
| `slots` | The statement taken apart, described below. |
| `previousStatement` | `edited` only: the wording before the branch. |
| `previousSlots` | `edited` only: the slots before the branch. |
| `quote` | The exact words in the source message that the requirement was drawn from. It is always a substring of that message's `text`. |
| `source.messageId` | The message in `session.json` that the requirement came from. |
| `source.author` | Who wrote that message: `user` for the developer, `model` for the agent. A `model` requirement is one the agent put forward itself rather than something the developer said. When the developer picked one of the agent's options, the requirement cites the option text, so its author is `model`. |
| `code` | Where the requirement is implemented on the branch. For `removed`, it is the code that makes the requirement no longer hold. Each entry is a `file` (repository-relative) and `lines`, an inclusive 1-based `[start, end]` range in that file as it is on `diet-modes`, the new side of the diff. Ranges may overlap between requirements. |

### Slots

Every statement is built from its slots, so a change between `previousSlots` and
`slots` is a change between the two statements:

| Slot | Meaning |
| --- | --- |
| `scope` | What the requirement is about: "the system", "remix mode", "the recipe list pane". |
| `preconditions` | States that must hold for it to apply. Each becomes a "While …" clause. Often empty. |
| `trigger` | Optional. The event it responds to, rendered as "When …". |
| `verb` | What the scope shall do. |
| `object` | What it is done to. |
| `modifiers` | Qualifications of the action, each appended after a comma. Often empty. |
| `why` | Optional. The reason, rendered as ", so that …". |

They render in this order:

```
While <preconditions, joined by " and ">, when <trigger>, <scope> shall <verb> <object>, <modifier>, …, so that <why>
```

Leave out any clause whose slot is empty, and capitalise the first letter. For
example, `{ "scope": "the recipe list", "preconditions": [], "trigger": "a recipe
fails the diet check", "verb": "hide", "object": "that recipe", "modifiers": [] }`
renders as "When a recipe fails the diet check, the recipe list shall hide that
recipe".
