'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ENV_FILE = path.join(__dirname, '.env');

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      const rl = readline.createInterface({ input, output: process.stdout });
      rl.question(`${prompt} `, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    process.stdout.write(prompt + ' ');
    let answer = '';
    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\u0003') {
        cleanup();
        process.stdout.write('\nConfiguration annulée.\n');
        reject(new Error('Configuration annulée'));
        process.exitCode = 1;
        return;
      }
      if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(answer);
        return;
      }
      if (char === '\u007f' || char === '\b') {
        answer = answer.slice(0, -1);
        return;
      }
      if (char >= ' ' && char !== '\u007f') answer += char;
    };
    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    }
    input.on('data', onData);
  });
}

async function main() {
  if (fs.existsSync(ENV_FILE)) {
    console.log('Le fichier .env existe déjà. Il n’a pas été modifié.');
    console.log('Pour changer le mot de passe, modifie ADMIN_PASSWORD dans .env puis redémarre le serveur.');
    return;
  }

  console.log('\nConfiguration Love Meter — le mot de passe ne sera pas écrit dans le code.');
  const first = await askHidden('Choisis un mot de passe admin (12 caractères minimum) :');
  const second = await askHidden('Confirme le mot de passe :');

  if (first.length < 12) throw new Error('Le mot de passe doit contenir au moins 12 caractères.');
  if (first !== second) throw new Error('Les mots de passe ne correspondent pas.');
  if (/[\r\n]/.test(first)) throw new Error('Le mot de passe ne peut pas contenir de retour à la ligne.');

  const contents = `# Fichier local privé : ne partage jamais ce fichier.\nADMIN_PASSWORD=${JSON.stringify(first)}\n# Pour un autre port ou un accès depuis le réseau local, décommente puis modifie les lignes suivantes.\n# PORT=3000\n# HOST=0.0.0.0\n`;
  fs.writeFileSync(ENV_FILE, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log('\nConfiguration enregistrée dans .env. Ce fichier est ignoré par Git.');
  console.log('Tu peux maintenant lancer : node server.js\n');
}

main().catch((error) => {
  console.error(`\nErreur : ${error.message}\n`);
  process.exitCode = 1;
});
