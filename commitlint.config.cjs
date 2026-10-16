module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0, 'always'], // Disables the rule
    // Disabled too: it refused a long BREAKING CHANGE note, and every long body line after a line naming an issue (#12), which the
    // parser reads as the start of the footer
    'footer-max-line-length': [0, 'always'],
    'header-max-length': [2, 'always', 125], // Throws error if the header is longer than 125 characters
  },
};
