# Code Style Rules

These conventions are enforced in code review. Follow them upfront to avoid rework.

## Imports & Cleanup

- Remove unused imports immediately. Do not leave dead imports.
- Remove unused variables and hook dependencies.

## Backend / TypeScript

- **Interface naming:** Use `I` prefix for interfaces (e.g., `IUpdatePageParams`).
- **Arrow functions** for closures inside methods, not `function` declarations.
- **Prettier:** One argument per line when function signature exceeds line length. Ternary operators get proper indentation with the condition on its own line.
- **Ternaries**: Never nest ternary conditions. Use only if it improves the reading flow.

