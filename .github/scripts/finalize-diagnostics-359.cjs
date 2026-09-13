const fs = require('fs');
const path = require('path');

const appDir = process.argv[2];
if (!appDir) throw new Error('APP_DIR mancante');
const file = rel => path.join(appDir, rel);

let main = fs.readFileSync(file('electron/main.js'), 'utf8');
if (!main.includes('let autoUpdateController = null;')) {
  main = main.replace('let fiscalIdempotency = null;\n', 'let fiscalIdempotency = null;\nlet autoUpdateController = null;\n');
}
if (!main.includes('autoUpdateController = setupRiflessaAutoUpdater({')) {
  main = main.replace('  setupRiflessaAutoUpdater({\n', '  autoUpdateController = setupRiflessaAutoUpdater({\n');
}
const oldState = '    latestLocalBackupMtime:latest || null, idempotency:idempotencyStore().summary()\n';
const newState = '    latestLocalBackupMtime:latest || null, idempotency:idempotencyStore().summary(),\n    updater:autoUpdateController?.getState?.() || null\n';
if (main.includes(oldState)) main = main.replace(oldState, newState);
if (!main.includes('updater:autoUpdateController?.getState?.() || null')) throw new Error('Patch updater state non applicata');
fs.writeFileSync(file('electron/main.js'), main);

let rules = fs.readFileSync(file('firestore.rules'), 'utf8');
if (!rules.includes('function isDeveloper()')) {
  rules = rules.replace(
    "    function isStaff() { return signedIn() && (role() == 'admin' || role() == 'staff'); }\n",
    "    function isStaff() { return signedIn() && (role() == 'admin' || role() == 'staff'); }\n    function isDeveloper() { return signedIn() && exists(/databases/$(database)/documents/developerAccess/$(request.auth.uid)); }\n"
  );
}
const oldBlock = `    match /deviceStatus/{deviceId} {
      allow read: if isAdmin();
      allow create, update: if isStaff()
        && request.resource.data.schemaVersion == 1
        && request.resource.data.deviceId == deviceId
        && request.resource.data.operatorUid == request.auth.uid;
      allow delete: if isAdmin();
    }
`;
const newBlock = `    match /developerAccess/{uid} {
      allow read: if signedIn() && request.auth.uid == uid;
      allow write: if false;
    }

    match /deviceStatus/{deviceId} {
      allow read: if isDeveloper();
      allow create, update: if isStaff()
        && request.resource.data.schemaVersion == 2
        && request.resource.data.deviceId == deviceId
        && request.resource.data.operatorUid == request.auth.uid
        && request.resource.data.keys().hasOnly([
          'schemaVersion','deviceId','deviceLabel','operatorUid','appVersion','platform','channel',
          'rtReachable','fiscalQueueDepth','fiscalActiveLabel','idempotencyInflight',
          'idempotencyUncertain','idempotencyUnresolved','localRecoveryCount','activeFiscalIntent',
          'latestLocalBackupMtime','network','updater','lastRtError','lastAppError','lastSeenAt','lastSeenAtClient'
        ]);
      allow delete: if isDeveloper();
    }
`;
if (rules.includes(oldBlock)) rules = rules.replace(oldBlock, newBlock);
if (!rules.includes('match /developerAccess/{uid}')) throw new Error('Patch developerAccess non applicata');
fs.writeFileSync(file('firestore.rules'), rules);
