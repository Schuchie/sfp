import ScratchOrgUtils, { ScratchOrg } from "../pool/utils/ScratchOrgUtils";
import { Org } from "@salesforce/core";
import ArtifactGenerator from "@dxatscale/sfpowerscripts.core/lib/generators/ArtifactGenerator";
import * as fs from "fs-extra";
import Bottleneck from "bottleneck";
import * as rimraf from "rimraf";
import { SfdxApi } from "../pool/sfdxnode/types";
import PrepareASingleOrgImpl, {
  ScriptExecutionResult,
} from "./PrepareASingleOrgImpl";
import ManifestHelpers from "@dxatscale/sfpowerscripts.core/lib/manifest/ManifestHelpers";
import child_process = require("child_process");
import BuildImpl from "../parallelBuilder/BuildImpl";
import SFPLogger from "@dxatscale/sfpowerscripts.core/lib/utils/SFPLogger";
export default class PrepareImpl {
  private poolConfig: PoolConfig;
  private totalToBeAllocated: number;
  private limits;
  private totalAllocated: number = 0;
  private limiter;
  private scriptExecutorWrappedForBottleneck;
  private fetchArtifactScript: string;
  private keys: string
  private installAll:boolean;
  private installAsSourcePackages: boolean;
  private succeedOnDeploymentErrors: boolean;


  public constructor(
    private hubOrg: Org,
    private apiversion: string,
    private sfdx: SfdxApi,
    private tag: string,
    private expiry: number,
    private max_allocation: number,
    private configFilePath: string,
    private batchSize: number
  ) {
    this.limiter = new Bottleneck({
      maxConcurrent: this.batchSize,
    });

    this.scriptExecutorWrappedForBottleneck = this.limiter.wrap(
      this.scriptExecutor
    );
  }

  public setArtifactFetchScript(fetchArtifactScript:string)
  {
      this.fetchArtifactScript=fetchArtifactScript;
  }

  public setInstallationBehaviour(installAll:boolean,installAsSourcePackages:boolean,succeedOnDeploymentErrors:boolean)
  {
    this.installAll =installAll;
    this.installAsSourcePackages=installAsSourcePackages;
    this.succeedOnDeploymentErrors=succeedOnDeploymentErrors;
  }

  public setPackageKeys(keys:string)
  {
    this.keys=keys;
  }



  public async poolScratchOrgs(): Promise< {
    totalallocated:number
    success: number;
    failed: number;
  }> {
    await ScratchOrgUtils.checkForNewVersionCompatible(this.hubOrg);
    let scriptExecPromises: Array<Promise<ScriptExecutionResult>> = new Array();

    await this.hubOrg.refreshAuth();

    let preRequisiteCheck = await ScratchOrgUtils.checkForPreRequisite(
      this.hubOrg
    );

    if (!preRequisiteCheck) {
      console.log(
        "Required Prerequisite fields are missing in the DevHub, Please look into the wiki to getting the fields deployed in DevHub"
      );
      return {totalallocated:this.totalAllocated,success:0,failed:this.totalToBeAllocated};
    }

    //Set Pool Config Option
    this.poolConfig = {
      pool: {
        expiry: this.expiry,
        config_file_path: this.configFilePath,
        tag: this.tag,
        max_allocation: this.max_allocation,
        user_mode: false,
      },
    };

    //Set Tag Only mode activated for the default use case
    this.setASingleUserForTagOnlyMode();

    //fetch current status limits
    await this.fetchCurrentLimits();

    //Compute allocation
    this.totalToBeAllocated = await this.computeAllocation();

    if (this.totalToBeAllocated === 0) {
      if (this.limits.ActiveScratchOrgs.Remaining > 0)
        console.log(
          `The tag provided ${this.poolConfig.pool.tag} is currently at the maximum capacity , No scratch orgs will be allocated`
        );
      else
        console.log(
          `There is no capacity to create a pool at this time, Please try again later`
        );
      return {totalallocated:this.totalAllocated,success:0,failed:0};
    }


    // Setup Logging Directory
    rimraf.sync("script_exec_outputs");
    fs.mkdirpSync("script_exec_outputs");

    //Create Artifact Directory
    rimraf.sync("artifacts");
    fs.mkdirpSync("artifacts");

    //Fetch Latest Artifacts to Artifact Directory
    if (this.installAll) {
       await this.getPackageArtifacts();
    }

    //Generate Scratch Orgs
    await this.generateScratchOrgs();

    // Assign workers to executed scripts

    for (let poolUser of this.poolConfig.poolUsers) {
      for (let scratchOrg of poolUser.scratchOrgs) {


        let result = this.scriptExecutorWrappedForBottleneck(
          scratchOrg,
          this.hubOrg.getUsername()
        );
        scriptExecPromises.push(result);
      }
    }

     await Promise.all(scriptExecPromises);


    let finalizedResults = await this.finalizeGeneratedScratchOrgs();

    return {totalallocated:this.totalAllocated,success:finalizedResults.success,failed:finalizedResults.failed};
  }

  private async getPackageArtifacts() {
    let packages = ManifestHelpers.getSFDXPackageManifest(null)[
      "packageDirectories"
    ];

    if (fs.existsSync(this.fetchArtifactScript)) {
      packages.forEach((pkg) => {
        this.fetchArtifactFromRepositoryUsingProvidedScript(
          pkg.package,
          "artifacts",
          this.fetchArtifactScript
        );
      });
    } else {
      //Build All Artifacts
      console.log("\n");
      console.log("-------------------------------WARNING!!!!------------------------------------------------")
      console.log("Building packages, as script to fetch artifacts was not provided");
      console.log("This is not ideal, as the artifacts are  built from the current head of the provided branch" );
      console.log("Pools should be prepared with previously validated packages");
      console.log("---------------------------------------------------------------------------------------------")
      let buildImpl = new BuildImpl(
        this.configFilePath,
        null,
        this.hubOrg.getUsername(),
        null,
        "120",
        true,
        false,
        1,
        10,
        true,
        null
      );
      let { generatedPackages, failedPackages } = await buildImpl.exec();


      if(failedPackages.length>0)
       throw new Error("Unable to build packages, Following packages failed to build"+failedPackages);

      for (let generatedPackage of generatedPackages) {
        await ArtifactGenerator.generateArtifact(
          generatedPackage.package_name,
          process.cwd(),
          "artifacts",
          generatedPackage
        );
      }
    }
  }

  private setASingleUserForTagOnlyMode() {
    //Remove any existing pool Config for pool users
    if (this.poolConfig.poolUsers) delete this.poolConfig.poolUsers;

    let poolUser: PoolUser = {
      min_allocation: this.poolConfig.pool.max_allocation,
      max_allocation: this.poolConfig.pool.max_allocation,
      is_build_pooluser: false,
      expiry: this.poolConfig.pool.expiry,
      priority: 1,
    };
    //Add a single user
    this.poolConfig.poolUsers = [];
    this.poolConfig.poolUsers.push(poolUser);
    this.poolConfig.pool.user_mode = false;
  }

  private async fetchCurrentLimits() {
    try {
      this.limits = await ScratchOrgUtils.getScratchOrgLimits(
        this.hubOrg,
        this.apiversion
      );
    } catch (error) {
      console.log("Unable to connect to DevHub");
      return;
    }
  }

  private async computeAllocation(): Promise<number> {
    //Compute current pool requirement

    let activeCount = await ScratchOrgUtils.getCountOfActiveScratchOrgsByTag(
      this.poolConfig.pool.tag,
      this.hubOrg
    );
    return this.allocateScratchOrgsPerTag(
      this.limits.ActiveScratchOrgs.Remaining,
      activeCount,
      this.poolConfig.pool.tag,
      this.poolConfig.poolUsers[0]
    );
  }

  private async generateScratchOrgs() {
    //Generate Scratch Orgs
    for (let poolUser of this.poolConfig.poolUsers) {
      let count = 1;
      poolUser.scratchOrgs = new Array<ScratchOrg>();
      for (let i = 0; i < poolUser.to_allocate; i++) {
        console.log(
          `Creating Scratch  Org  ${count} of ${this.totalToBeAllocated}..`
        );
        try {
          let scratchOrg: ScratchOrg = await ScratchOrgUtils.createScratchOrg(
            this.sfdx,
            count,
            poolUser.username,
            this.poolConfig.pool.config_file_path,
            poolUser.expiry ? poolUser.expiry : this.poolConfig.pool.expiry,
            this.hubOrg
          );
          poolUser.scratchOrgs.push(scratchOrg);
          this.totalAllocated++;
        } catch (error) {
          console.log(`Unable to provision scratch org  ${count} ..   `);
        }
        count++;
      }

      await ScratchOrgUtils.getScratchOrgRecordId(
        poolUser.scratchOrgs,
        this.hubOrg
      );

      if (ScratchOrgUtils.isNewVersionCompatible) {
        let scratchOrgInprogress = [];

        poolUser.scratchOrgs.forEach((scratchOrg) => {
          scratchOrgInprogress.push({
            Id: scratchOrg.recordId,
            Pooltag__c: this.poolConfig.pool.tag,
            Allocation_status__c: "In Progress",
          });
        });

        if (scratchOrgInprogress.length > 0) {
          //set pool tag
          await ScratchOrgUtils.setScratchOrgInfo(
            scratchOrgInprogress,
            this.hubOrg
          );
        }
      }
    }
  }

  private async finalizeGeneratedScratchOrgs(): Promise<{
    success: number;
    failed: number;
  }> {
    //Store Username Passwords
    let failed = 0;
    let success = 0;

    for (let poolUser of this.poolConfig.poolUsers) {
      for (let scratchOrg of poolUser.scratchOrgs) {
        if (scratchOrg.isScriptExecuted) {
          success++;
          continue;
        }

        console.log(
          `Failed to execute scripts for ${scratchOrg.username} with alias ${scratchOrg.alias}.. Returning to Pool`
        );

        try {
          //Delete scratchorgs that failed to execute script

          let activeScratchOrgRecordId = await ScratchOrgUtils.getActiveScratchOrgRecordIdGivenScratchOrg(
            this.hubOrg,
            this.apiversion,
            scratchOrg.orgId
          );

          await ScratchOrgUtils.deleteScratchOrg(
            this.hubOrg,
            this.apiversion,
            activeScratchOrgRecordId
          );
          console.log(`Succesfully deleted scratchorg  ${scratchOrg.username}`);
        } catch (error) {
          console.log(
            `Unable to delete the scratchorg ${scratchOrg.username}..`
          );
        }

        failed++;
      }
    }

    return { success: success, failed: failed };
  }

  private allocateScratchOrgsPerTag(
    remainingScratchOrgs: number,
    countOfActiveScratchOrgs: number,
    tag: string,
    poolUser: PoolUser
  ) {
    console.log("Remaining ScratchOrgs in the org:" + remainingScratchOrgs);
    poolUser.current_allocation = countOfActiveScratchOrgs;
    poolUser.to_allocate = 0;
    poolUser.to_satisfy_max =
      poolUser.max_allocation - poolUser.current_allocation > 0
        ? poolUser.max_allocation - poolUser.current_allocation
        : 0;

    if (
      poolUser.to_satisfy_max > 0 &&
      poolUser.to_satisfy_max <= remainingScratchOrgs
    ) {
      poolUser.to_allocate = poolUser.to_satisfy_max;
    } else if (
      poolUser.to_satisfy_max > 0 &&
      poolUser.to_satisfy_max > remainingScratchOrgs
    ) {
      poolUser.to_allocate = remainingScratchOrgs;
    }

    console.log("Computed Allocation:" + JSON.stringify(poolUser));
    return poolUser.to_allocate;
  }

  private async scriptExecutor(
    scratchOrg: ScratchOrg,
    hubOrgUserName:string
  ): Promise<ScriptExecutionResult> {
    //Need to call PrepareAnOrgImpl

    console.log(
      `Executing script for ${scratchOrg.alias} with username: ${scratchOrg.username}`
    );

    console.log(
      `Script Execution result is being written to .sfpowerscripts/prepare_logs/${scratchOrg.alias}.log, Please note this will take a significant time depending on the  script being executed`
    );

    SFPLogger.isSupressLogs=true;

    let prepareASingleOrgImpl: PrepareASingleOrgImpl = new PrepareASingleOrgImpl(
      this.sfdx,
      scratchOrg,
      hubOrgUserName
    );

    prepareASingleOrgImpl.setInstallationBehaviour(this.installAll,this.installAsSourcePackages,this.succeedOnDeploymentErrors);
    prepareASingleOrgImpl.setPackageKeys(this.keys);

    let result = await prepareASingleOrgImpl.prepare();

    if (result.isSuccess) {
      scratchOrg.isScriptExecuted=true;
      let submitInfoToPool = await ScratchOrgUtils.setScratchOrgInfo(
        {
          Id: scratchOrg.recordId,
          Pooltag__c: this.poolConfig.pool.tag,
          Allocation_status__c: ScratchOrgUtils.isNewVersionCompatible
            ? "Available"
            : "",
          Password__c: scratchOrg.password,
        },
        this.hubOrg
      );
      if (!submitInfoToPool) {
        result.isSuccess = false;
        result.status = "failure";
        result.message = "Unable to set the scratch org record in Pool";
      }
    }

    return result;
  }

  private fetchArtifactFromRepositoryUsingProvidedScript(
    packageName: string,
    artifactDirectory: string,
    scriptPath: string
  ) {
 
    let cmd: string;
    if (process.platform !== "win32") {
      cmd = `bash -e ${scriptPath} ${packageName} ${artifactDirectory}`;
    } else {
      cmd = `cmd.exe /c ${scriptPath} ${packageName}  ${artifactDirectory}`;
    }

    child_process.execSync(cmd, {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
}

export interface PoolConfig {
  pool: Pool;
  poolUsers?: PoolUser[];
}

export interface Pool {
  expiry: number;
  config_file_path: string;
  script_file_path?: string;
  tag: string;
  user_mode: boolean;
  max_allocation: number;
}

export interface PoolUser {
  max_allocation: number;
  min_allocation: number;
  is_build_pooluser: boolean;
  username?: string;
  expiry?: number;
  priority: number;
  scripts?: string[];
  current_allocation?: number;
  to_allocate?: number;
  to_satisfy_min?: number;
  to_satisfy_max?: number;
  scratchOrgs?: ScratchOrg[];
}
