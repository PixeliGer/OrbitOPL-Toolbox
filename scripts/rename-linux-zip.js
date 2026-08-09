const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

module.exports = async function (buildResult) {
  return buildResult.artifactPaths.map(artifactPath => {
    const base = path.basename(artifactPath);
    if (!base.endsWith('.zip') || base.includes('-win') || !base.includes(`-${version}`)) {
      return artifactPath;
    }
    const renamedPath = path.join(path.dirname(artifactPath), base.replace(`-${version}`, `-linux-${version}`));
    fs.renameSync(artifactPath, renamedPath);
    return renamedPath;
  });
};
