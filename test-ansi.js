const stripAnsi = (str) => {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
  ].join('|');

  return str.replace(new RegExp(pattern, 'g'), '');
};
console.log(stripAnsi("\u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m"));
