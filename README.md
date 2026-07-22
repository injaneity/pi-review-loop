# Review Loop

A persistent, incremental diff reviewer for [pi](https://pi.dev).

Review Loop keeps a native review window open while the agent works. Submit a review to checkpoint the current workspace; the next review shows only what changed since that checkpoint.

## Install

```sh
pi install git:https://github.com/badlogic/pi-review-loop
```

Then run:

```text
/review
```

## Workflow

1. Open Review Loop with `/review`.
2. Agent edits appear in a recent list and compact file tree.
3. Review the diff and leave line or file comments.
4. Submit the review. Feedback is inserted into pi's editor and the current workspace becomes the reviewed checkpoint.
5. The next diff contains only newer changes.

## Diff modes

- **Since review** compares the current workspace with the last submitted review checkpoint. Before the first review, it compares with `HEAD`.
- **vs HEAD** shows the complete working-tree diff against `HEAD`.

The Recently Changed section follows the active diff mode and is ordered by filesystem modification time. In `vs HEAD`, files matching the latest review checkpoint remain visible with a reviewed checkmark.

Review checkpoints are stored as custom entries in the active pi session and restored when that session is resumed. Custom entries are not included in model context.

## Requirements

- Node.js 20+
- pi
- Git repository
- macOS, Linux, or Windows supported by Glimpse

## Development

```sh
npm install
npm run build
npm test
pi -e ./src/index.ts
```
