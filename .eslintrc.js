module.exports = {
  env: {
    node: true,
    jest: true,
    es2020: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2020,
  },
  globals: {
    lastS3ClientConfiguration: 'writable',
    mockS3Send: 'writable',
  },
  rules: {
    // General code quality
    'no-var': 'error',
    'prefer-const': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['error', 'warn', 'log'] }],
    curly: ['error', 'all'],
    eqeqeq: ['error', 'always'],
    'no-param-reassign': 'error',
    'no-return-await': 'error',
    'prefer-promise-reject-errors': 'error',
    'require-await': 'error',

    // Style
    semi: ['error', 'always'],
    quotes: ['error', 'single', { avoidEscape: true }],
    'comma-dangle': ['error', 'always-multiline'],
    indent: ['error', 2, { SwitchCase: 1 }],
    'arrow-parens': ['error', 'always'],
    'arrow-spacing': 'error',
    'space-before-function-paren': [
      'error',
      {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always',
      },
    ],
    'object-curly-spacing': ['error', 'always'],
    'block-spacing': 'error',
    'brace-style': ['error', '1tbs', { allowSingleLine: false }],
    'key-spacing': ['error', { beforeColon: false, afterColon: true }],
    'keyword-spacing': 'error',
    'linebreak-style': ['error', 'unix'],
    'no-trailing-spaces': 'error',
    'eol-last': ['error', 'always'],
  },
};
