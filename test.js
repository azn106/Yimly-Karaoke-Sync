const { spawnSync } = require('child_process');
const pyScript = `
import sys, json
info = {"available": True, "version": sys.version.split()[0]}
print("###JSON_START###" + json.dumps(info) + "###JSON_END###")
`;
const proc = spawnSync('python3', ['-'], { input: pyScript, encoding: 'utf-8', timeout: 8000 });
console.log(proc.stdout);
console.log(proc.stderr);
