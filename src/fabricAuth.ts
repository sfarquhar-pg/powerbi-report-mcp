import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  InteractiveBrowserCredential,
  deserializeAuthenticationRecord,
  serializeAuthenticationRecord,
  useIdentityPlugin,
  type AccessToken,
  type AuthenticationRecord,
} from "@azure/identity";

export const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
export const POWERBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const CACHE_NAME = "powerbi-report-mcp";

export type FabricResource = "fabric" | "powerbi";
export type FabricCacheMode = "memory" | "persistent";

interface CredentialLike {
  authenticate(scopes: string | string[], options?: { tenantId?: string }): Promise<AuthenticationRecord | undefined>;
  getToken(scopes: string | string[], options?: { tenantId?: string }): Promise<AccessToken | null>;
}

type CredentialFactory = (options: {
  authenticationRecord?: AuthenticationRecord;
  disableAutomaticAuthentication: boolean;
  persistent: boolean;
}) => CredentialLike;

export class FabricAuthenticationRequiredError extends Error {
  constructor(message = "Fabric authentication required. Call pbir_fabric_auth with operation='login'.") {
    super(message);
    this.name = "FabricAuthenticationRequiredError";
  }
}

function defaultRecordPath(): string {
  return path.join(os.homedir(), ".config", "powerbi-report-mcp", "authentication-record.json");
}

let persistencePluginRegistered = false;

export class FabricAuthManager {
  private readonly cacheMode: FabricCacheMode;
  private readonly recordPath: string;
  private readonly credentialFactory: CredentialFactory;
  private readonly fabricScope: string;
  private readonly powerBiScope: string;
  private authenticationRecord?: AuthenticationRecord;
  private tokens = new Map<FabricResource, AccessToken>();
  private silentCredential?: CredentialLike;

  constructor(options: {
    cacheMode?: FabricCacheMode;
    recordPath?: string;
    credentialFactory?: CredentialFactory;
    fabricScope?: string;
    powerBiScope?: string;
  } = {}) {
    this.cacheMode = options.cacheMode ??
      (process.env.PBIR_FABRIC_TOKEN_CACHE?.toLowerCase() === "persistent" ? "persistent" : "memory");
    this.recordPath = options.recordPath ?? defaultRecordPath();
    this.fabricScope = options.fabricScope ?? process.env.PBIR_FABRIC_SCOPE ?? FABRIC_SCOPE;
    this.powerBiScope = options.powerBiScope ?? process.env.PBIR_POWERBI_SCOPE ?? POWERBI_SCOPE;

    this.credentialFactory = options.credentialFactory ?? ((credentialOptions) =>
      new InteractiveBrowserCredential({
        tenantId: process.env.AZURE_TENANT_ID,
        clientId: process.env.AZURE_CLIENT_ID,
        authorityHost: process.env.AZURE_AUTHORITY_HOST,
        // The initial account chooser may land in a B2B/resource tenant. After
        // login every request is pinned to authenticationRecord.tenantId; no
        // MCP tool accepts an arbitrary tenant override.
        additionallyAllowedTenants: ["*"],
        authenticationRecord: credentialOptions.authenticationRecord,
        disableAutomaticAuthentication: credentialOptions.disableAutomaticAuthentication,
        tokenCachePersistenceOptions: credentialOptions.persistent ? {
          enabled: true,
          name: CACHE_NAME,
          // Never permit plaintext fallback when the OS keyring is unavailable.
          unsafeAllowUnencryptedStorage: false,
        } : undefined,
        browserCustomizationOptions: {
          successMessage: "Power BI Report MCP authentication succeeded. You can close this window.",
          errorMessage: "Power BI Report MCP authentication failed. Return to your MCP client for details.",
        },
      }));

    if (this.cacheMode === "persistent") {
      this.authenticationRecord = this.readAuthenticationRecord();
    }
  }

  getStatus(): Record<string, unknown> {
    const expires = Object.fromEntries(
      [...this.tokens.entries()].map(([resource, token]) => [resource, new Date(token.expiresOnTimestamp).toISOString()])
    );
    return {
      authenticated: this.hasUsableToken("fabric") && this.hasUsableToken("powerbi"),
      account: this.authenticationRecord?.username,
      tenantId: this.authenticationRecord?.tenantId,
      cacheMode: this.cacheMode,
      persistentCacheConfigured: this.cacheMode === "persistent",
      expires,
      tokenExposed: false,
      note: this.cacheMode === "memory"
        ? "Tokens are held only in this MCP server process. Restarting the server requires login again."
        : "Tokens are stored by Azure Identity in encrypted OS storage. Plaintext fallback is disabled.",
    };
  }

  async login(force = false): Promise<Record<string, unknown>> {
    await this.ensurePersistencePlugin();
    if (force) this.clearMemory();

    if (!force && this.authenticationRecord && this.cacheMode === "persistent") {
      try {
        const silent = this.silentCredential ?? this.createCredential(true);
        await this.acquireBoth(silent);
        this.silentCredential = silent;
        return { ...this.getStatus(), interactive: false };
      } catch {
        this.clearMemory();
      }
    }

    try {
      // authenticate() is the only operation allowed to open a browser. The
      // credential itself has automatic interaction disabled for later calls.
      const credential = this.createCredential(true);
      const record = await credential.authenticate(this.fabricScope);
      if (!record) throw new Error("Microsoft Entra authentication returned no account record.");
      await credential.authenticate(this.powerBiScope, { tenantId: record.tenantId });
      this.authenticationRecord = record;
      await this.acquireBoth(credential);
      if (this.cacheMode === "persistent") this.writeAuthenticationRecord(record);
      // Reuse this credential so Azure Identity can refresh from its in-memory
      // cache, but cannot open a browser during an unrelated report action.
      this.silentCredential = credential;
      return { ...this.getStatus(), interactive: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.cacheMode === "persistent" && /keyring|keychain|persistence|keytar|secret/i.test(message)) {
        throw new Error(
          `Encrypted persistent token caching is unavailable: ${message} ` +
          "Install/configure the OS keyring, or unset PBIR_FABRIC_TOKEN_CACHE to use process-only memory caching."
        );
      }
      throw error;
    }
  }

  signOut(): Record<string, unknown> {
    this.clearMemory();
    if (fs.existsSync(this.recordPath)) fs.unlinkSync(this.recordPath);
    return {
      authenticated: false,
      cacheMode: this.cacheMode,
      tokenExposed: false,
      note: this.cacheMode === "persistent"
        ? "The MCP session and account locator were removed. Azure Identity's encrypted OS cache may retain revocable token material."
        : "The process-only token session was removed.",
    };
  }

  async getToken(resource: FabricResource): Promise<string> {
    const cached = this.tokens.get(resource);
    if (cached && cached.expiresOnTimestamp > Date.now() + 60_000) return cached.token;

    if (this.silentCredential && this.authenticationRecord) {
      try {
        const credential = this.silentCredential;
        const token = await credential.getToken(
          resource === "fabric" ? this.fabricScope : this.powerBiScope,
          { tenantId: this.authenticationRecord.tenantId }
        );
        if (!token) throw new Error("No access token returned.");
        this.tokens.set(resource, token);
        return token.token;
      } catch {
        throw new FabricAuthenticationRequiredError("The encrypted Fabric session cannot refresh silently. Call pbir_fabric_auth with operation='login'.");
      }
    }

    if (this.cacheMode === "persistent" && this.authenticationRecord) {
      try {
        await this.ensurePersistencePlugin();
        const credential = this.createCredential(true);
        const token = await credential.getToken(
          resource === "fabric" ? this.fabricScope : this.powerBiScope,
          { tenantId: this.authenticationRecord.tenantId }
        );
        if (!token) throw new Error("No access token returned.");
        this.tokens.set(resource, token);
        this.silentCredential = credential;
        return token.token;
      } catch {
        throw new FabricAuthenticationRequiredError("The encrypted Fabric session cannot refresh silently. Call pbir_fabric_auth with operation='login'.");
      }
    }

    throw new FabricAuthenticationRequiredError();
  }

  private createCredential(disableAutomaticAuthentication: boolean): CredentialLike {
    return this.credentialFactory({
      authenticationRecord: this.authenticationRecord,
      disableAutomaticAuthentication,
      persistent: this.cacheMode === "persistent",
    });
  }

  private async ensurePersistencePlugin(): Promise<void> {
    if (this.cacheMode !== "persistent" || persistencePluginRegistered) return;
    try {
      const { cachePersistencePlugin } = await import("@azure/identity-cache-persistence");
      useIdentityPlugin(cachePersistencePlugin);
      persistencePluginRegistered = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Encrypted persistent token caching could not start: ${message} ` +
        "Install/configure the OS keyring and native keytar dependency, or unset PBIR_FABRIC_TOKEN_CACHE to use process-only memory caching."
      );
    }
  }

  private async acquireBoth(credential: CredentialLike): Promise<void> {
    const tenantId = this.authenticationRecord?.tenantId;
    const fabric = await credential.getToken(this.fabricScope, { tenantId });
    const powerbi = await credential.getToken(this.powerBiScope, { tenantId });
    if (!fabric || !powerbi) throw new Error("Microsoft Entra did not return both required access tokens.");
    this.tokens.set("fabric", fabric);
    this.tokens.set("powerbi", powerbi);
  }

  private hasUsableToken(resource: FabricResource): boolean {
    const token = this.tokens.get(resource);
    return !!token && token.expiresOnTimestamp > Date.now() + 60_000;
  }

  private clearMemory(): void {
    this.tokens.clear();
    this.silentCredential = undefined;
    this.authenticationRecord = undefined;
  }

  private readAuthenticationRecord(): AuthenticationRecord | undefined {
    try {
      if (!fs.existsSync(this.recordPath)) return undefined;
      return deserializeAuthenticationRecord(fs.readFileSync(this.recordPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private writeAuthenticationRecord(record: AuthenticationRecord): void {
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.recordPath, serializeAuthenticationRecord(record), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(this.recordPath, 0o600);
  }
}
