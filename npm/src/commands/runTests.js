// @flow

import {child_process, fs, os, path} from "../lib/node.js";
import {copyFile, recursiveRmdir} from "../lib/fileUtils.js";
import {
  DEFINITIONS_DIR,
  getFlowVersionsForPackage,
  getPackages,
  getTestFilesInDir,
  versionToString,
} from "../lib/definitions.js";

import type {VersionedName} from "../lib/definitions.js";

import GitHub from "github";
import request from "request";
import * as semver from "semver";

// Used to decide which binary to fetch for each version of Flow
const BIN_PLATFORM = (_ => {
  switch (os.type()) {
    case "Linux": return "linux64";
    case "Darwin": return "osx";

    default: throw new Error(
      "Unsupported os.type()! " + os.type()
    );
  }
})();
const PKG_ROOT_DIR = path.join(__dirname, "..", "..");
const TEST_DIR = path.join(PKG_ROOT_DIR, "test-dir");
const BIN_DIR = path.join(PKG_ROOT_DIR, "flow-bins");
const P = Promise;

type TestGroup = {
  id: string,
  testFilePaths: Array<string>,
  libDefPath: string,
  flowVersion: string,
};

/**
 * Scan the definitions/ directory to extract a flat list of TestGroup
 * structs. Each TestGroup represents a Package/PackageVersion/FlowVersion
 * directory.
 */
async function getTestGroups(): Promise<Array<TestGroup>> {
  const testGroups = [];

  const pkgVersions = await getPackages();
  await P.all(pkgVersions.map(async (pkg) => {
    const pkgVerStr = versionToString(pkg.version);
    const [pkgTestFiles, flowVersions] = await P.all([
      getTestFilesInDir(pkg.path),
      getFlowVersionsForPackage(pkg),
    ]);

    await P.all(flowVersions.map(async (flowVer) => {
      const flowVerStr = versionToString(flowVer.version);
      const flowVerTestFiles = await getTestFilesInDir(flowVer.path);
      testGroups.push({
        id: pkg.name + "-" + pkgVerStr + "-flow-" + flowVerStr,
        testFilePaths: pkgTestFiles.concat(flowVerTestFiles),
        libDefPath: path.join(
          flowVer.path,
          pkg.name + '-' + pkgVerStr + '.js'
        ),
        flowVersion: flowVerStr,
      });
    }));
  }));

  return testGroups;
}

/**
 * Memoized function that queries the GitHub releases for Flow, downloads the
 * zip for each version, extracts the zip, and moves the binary to
 * TEST_BIN/flow-vXXX for use later when running tests.
 */
let _flowBinVersionPromise = null;
async function getOrderedFlowBinVersions(): Promise<Array<string>> {
  if (_flowBinVersionPromise === null) {
    _flowBinVersionPromise = (async function() {
      console.log("Fetching all Flow binaries...");
      const FLOW_BIN_VERSION_ORDER = [];
      const GH_CLIENT = new GitHub({version: "3.0.0"});
      if (process.env.GH_TOK) {
        GH_CLIENT.authenticate({
          type: "oauth",
          token: process.env.GH_TOK,
        });
      }
      const QUERY_PAGE_SIZE = 100;
      const OS_ARCH_FILTER_RE = new RegExp(BIN_PLATFORM);

      let binURLs = new Map();
      let releases = new Map();
      let apiPayload = null;
      let page = 0;
      while (apiPayload === null || apiPayload.length === QUERY_PAGE_SIZE) {
        apiPayload = await new Promise((res, rej) => {
          GH_CLIENT.releases.listReleases({
            owner: "facebook",
            repo: "flow",
            page: page++,
            per_page: QUERY_PAGE_SIZE,
          }, (err, result) => { if (err) { rej(err); } else { res(result); } });
        });

        apiPayload.forEach(rel => {
          // Suppression comments (which are needed in order to run tests) were
          // added in 0.12 -- so we only test against versions since then.
          if (semver.lt(rel.tag_name, "0.12.0")) {
            return;
          }

          // Find the binary zip in the list of assets
          const binZip = rel.assets.filter(({name}) => {
            return OS_ARCH_FILTER_RE.test(name) && !/-latest.zip$/.test(name);
          }).map(asset => asset.browser_download_url);

          if (binZip.length !== 1) {
            throw new Error(
              "Unexpected number of " + BIN_PLATFORM + " assets for flow-" +
              rel.tag_name + "! " + JSON.stringify(binZip)
            );
          } else {
            const version =
              rel.tag_name[0] === "v"
              ? rel.tag_name
              : "v" + rel.tag_name;

            FLOW_BIN_VERSION_ORDER.push(version);
            binURLs.set(version, binZip[0]);
          }
        });
      }

      FLOW_BIN_VERSION_ORDER.sort((a, b) => {
        return semver.lt(a, b) ? -1 : 1;
      });

      if (!await fs.exists(BIN_DIR)) {
        await fs.mkdir(BIN_DIR);
      }

      await P.all(Array.from(binURLs).map(async ([version, binURL]) => {
        const zipPath = path.join(BIN_DIR, "flow-" + version + ".zip");

        if (await fs.exists(path.join(BIN_DIR, "flow-" + version))) {
          return;
        }

        // Download the zip file
        await new Promise((res, rej) => {
          console.log("  Fetching flow-%s...", version)
          const fileRequest = request({
            url: binURL,
            headers: {
              "User-Agent": "flow-typed Test Runner " +
                            "(github.com/flowtype/flow-typed)"
            }
          }).on("error", err => rej(err));;

          fileRequest.pipe(fs.createWriteStream(zipPath).on("close", _ => {
            console.log("    flow-%s finished downloading.", version);
            res();
          }));
        });

        // Extract the flow binary
        const flowBinDirPath = path.join(BIN_DIR, "TMP-flow-" + version);
        await fs.mkdir(flowBinDirPath);
        console.log("  Extracting flow-%s...", version);
        await new Promise((res, rej) => {
          const child = child_process.exec(
            "unzip " + zipPath + " flow/flow -d " + flowBinDirPath
          );
          let stdErrOut = "";
          child.stdout.on("data", data => stdErrOut += data);
          child.stderr.on("data", data => stdErrOut += data);
          child.on("error", err => rej(err));
          child.on("close", code => {
            if (code === 0) { res(); } else { rej(stdErrOut); }
          });
        });
        await fs.rename(
          path.join(flowBinDirPath, "flow", "flow"),
          path.join(BIN_DIR, "flow-" + version)
        );
        console.log("  Removing flow-%s artifacts...", version);
        await P.all([
          recursiveRmdir(flowBinDirPath),
          fs.unlink(zipPath)
        ]);
        console.log("    flow-%s complete!", version);
      }));

      console.log("Finished fetching Flow binaries.\n");

      return FLOW_BIN_VERSION_ORDER;
    })();
  }
  return _flowBinVersionPromise;
}

/**
 * Given a TestGroup structure determine all versions of Flow that match the
 * FlowVersion specification and, for each, run `flow check` on the test
 * directory.
 */
async function runTestGroup(
  testGroup: TestGroup,
  errors = []
): Promise<Array<string>> {
  // Some older versions of Flow choke on ">"/"<"/"="
  const testDirName = testGroup.id
    .replace(/>/g, "gt")
    .replace(/</g, "lt")
    .replace(/=/g, "eq");

  const testDirPath = path.join(TEST_DIR, testDirName);
  if (await fs.exists(testDirPath)) {
    throw new Error(
      `Trying to run ${testGroup.id}, but test dir already exists! I'm` +
      `confused... Bailing out!`
    );
  }

  const orderedFlowVersions = await getOrderedFlowBinVersions();

  try {
    await fs.mkdir(testDirPath);

    // Copy files into the test dir
    const destLibDefPath = path.join(
      testDirPath,
      path.basename(testGroup.libDefPath)
    );
    await P.all([
      P.all(testGroup.testFilePaths.map(async (filePath, idx) => {
        // Because there could be multiple test files with the same basename,
        // we disambiguate each one with a locally-unique index.
        //
        // i.e. underscore/v1.x.x/test-underscore.js
        //      underscore/v1.x.x/flow-v0.22.x/test-underscore.js
        const destBasename = idx + "-" + path.basename(filePath);
        await copyFile(filePath, path.join(testDirPath, destBasename));
      })),
      copyFile(testGroup.libDefPath, destLibDefPath),
    ]);

    // Write out a .flowconfig
    const destFlowConfigPath = path.join(testDirPath, ".flowconfig");
    const flowConfigData = [
      "[libs]",
      path.basename(testGroup.libDefPath),
      "",
      "[options]",
      "suppress_comment=\\\\(.\\\\|\\n\\\\)*\\\\$ExpectError"
    ].join("\n");
    await fs.writeFile(destFlowConfigPath, flowConfigData);

    // For each compatible version of Flow, run `flow check` and verify there
    // are no errors.
    const flowVersionsToRun = orderedFlowVersions.filter(flowVer => {
      return (
        testGroup.flowVersion === "all"
        || semver.satisfies(flowVer, testGroup.flowVersion)
      );
    });

    while (flowVersionsToRun.length > 0) {
      // Run tests in batches to avoid saturation
      const testBatch = flowVersionsToRun
        .slice(0, Math.min(flowVersionsToRun.length, 5))
        .map(group => (flowVersionsToRun.shift(), group));

      await P.all(testBatch.map(async (flowVer) => {
        const testRunId = testGroup.id + " (flow-" + flowVer + ")";

        console.log("Testing %s...", testRunId);

        const {
          stdErrOut,
          errCode,
          execError
        } = await new Promise(res => {
          const child = child_process.exec([
            path.join(BIN_DIR, "flow-" + flowVer),
            "check",
            "--strip-root",
            testDirPath
          ].join(" "));

          let stdErrOut = "";
          child.stdout.on("data", data => stdErrOut += data);
          child.stderr.on("data", data => stdErrOut += data);

          child.on("error", execError => {
            res({stdErrOut, errCode: null, execError});
          });

          child.on("close", errCode => {
            res({stdErrOut, errCode, execError: null});
          });
        });

        if (execError !== null) {
          errors.push(
            testRunId + ": Error executing Flow process: " + execError.stack
          );
        } else if (errCode !== 0) {
          errors.push(
            testRunId + ": Unexpected Flow errors(" + String(errCode) + "):\n" +
            stdErrOut + "\n" +
            String(execError)
          );
        }
      }));
    }

    return errors;
  } finally {
    if (await fs.exists(testDirPath)) {
      await recursiveRmdir(testDirPath);
    }
  }
}

async function runTests(
  testPatterns: Array<string>
): Promise<Map<string, Array<string>>> {
  const testPatternRes = testPatterns.map(patt => new RegExp(patt, "g"));
  const testGroups = (await getTestGroups()).filter(testGroup => {
    if (testPatternRes.length === 0) {
      return true;
    }

    for (var i = 0; i < testPatternRes.length; i++) {
      if (testPatternRes[i].test(testGroup.id)) {
        return true;
      }
    }

    return false;
  });

  try {
    // Create a temp dir to copy files into to run the tests
    if (await fs.exists(TEST_DIR)) {
      await recursiveRmdir(TEST_DIR);
    }
    await fs.mkdir(TEST_DIR);

    const results = new Map();
    while (testGroups.length > 0) {
      const testGroup = testGroups.shift();
      const testGroupErrors = await runTestGroup(testGroup);
      if (testGroupErrors.length > 0) {
        const errors = results.get(testGroup.id) || [];
        testGroupErrors.forEach(err => errors.push(err));
        results.set(testGroup.id, errors);
      }
    }
    return results;
  } finally {
    if (await fs.exists(TEST_DIR)) {
      await recursiveRmdir(TEST_DIR);
    }
  }
}

export const name = "run-tests";
export const description = "Run definition tests";
export const options = {};
export async function run(argv: Object): Promise<number> {
  const testPatterns = argv._.slice(1);
  const results = await runTests(testPatterns);
  console.log(" ");
  Array.from(results).forEach(([testGroupName, errors]) => {
    console.log("ERROR: %s", testGroupName);
    errors.forEach(err => console.log(
      " * %s\n", err.split("\n").map((line, idx) => {
        return idx === 0 ? line : "   " + line;
      }).join("\n")
    ));
  });
  if (results.size === 0) {
    console.log("All tests passed!");
    return 0;
  }
  return 1;
};
