module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['@chax-at/eslint-config', 'prettier'],
  root: true,
  env: {
    node: true,
    jest: true,
    mocha: true,
  },
  globals: {
    NodeJS: "readonly",
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    'object-shorthand': ['off'],
    '@typescript-eslint/indent': ['off'],
    // Off: the codebase intentionally guards (?. / ??) against runtime nulls that
    // upstream types under-specify (Node API return values, parsed REST JSON,
    // array index access). The rule flags those guards as "unnecessary" based on
    // the (over-optimistic) static types; removing them would reintroduce real
    // runtime crashes, so we keep the defensive checks and disable the rule.
    '@typescript-eslint/no-unnecessary-condition': ['off'],
    '@typescript-eslint/no-unnecessary-type-assertion': ['warn'],
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    'spaced-comment': ['error', 'always', { line: { markers: ['#region', '#endregion'] } }],
  },
  overrides: [
    {
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-expressions': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        'func-names': 'off',
        'global-require': 'off',
        'import/no-dynamic-require': 'off',
        'import/no-unresolved': 'off',
        'prefer-arrow-callback': 'off',
      },
    },
    {
      files: ['**/*.cjs', '**/*.js'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
      },
    },
  ],
};
