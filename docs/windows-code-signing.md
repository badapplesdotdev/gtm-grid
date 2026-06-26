# Windows code signing (Azure Trusted Signing)

The release pipeline Authenticode-signs the Windows app `.exe` and the NSIS
installer using **Azure Trusted Signing** (Microsoft's cloud HSM signing service).
Signing is **gated**: until the Azure secrets below exist, the Windows build still
ships **unsigned** — nothing breaks, you just don't get a signature yet.

> Why a cloud service and not a `.pfx`? Since June 2023 the CA/Browser Forum
> requires every code-signing certificate (OV **and** EV) to live on FIPS
> hardware / a cloud HSM, so a certificate file in GitHub Secrets is no longer
> possible. Azure Trusted Signing is the cloud HSM.

## One-time setup

### 1. Azure — create the Trusted Signing resource
1. In the Azure portal, create a **Trusted Signing account** (search "Trusted Signing").
2. Complete **identity validation** for a **Certificate profile**:
   - Org must be **3+ years old** for the public-trust org flow, **or** use the
     **individual** validation flow (a few days, government-ID based).
3. Note three non-secret values:
   - **Endpoint** for your account's region, e.g. `https://eus.codesigning.azure.net/`
     (East US), `https://weu.codesigning.azure.net/` (West Europe).
   - **Account name**.
   - **Certificate profile name**.

### 2. Azure — a service principal CI can authenticate as
1. Create an **App registration** (Entra ID) → add a **client secret**.
2. On the Trusted Signing **account** (or resource group), grant that app the
   **"Trusted Signing Certificate Profile Signer"** role.
3. Collect: **Tenant ID**, **Client ID** (application id), **Client secret**.

### 3. GitHub — secrets and variables
In the repo → Settings → Secrets and variables → Actions:

**Secrets** (sensitive):
| Name | Value |
|------|-------|
| `AZURE_TENANT_ID` | Entra tenant id |
| `AZURE_CLIENT_ID` | App registration application id |
| `AZURE_CLIENT_SECRET` | App registration client secret |

**Variables** (not sensitive):
| Name | Value |
|------|-------|
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | Certificate profile name |

Once all three **secrets** are present, the next release signs automatically.

## Getting the values (fast path)

### A. Signing resources → gives you the 3 **Variables** (portal)
Identity validation is portal-only, so do this part in the portal.

1. Portal → search **Trusted Signing** → **Create**.
   - Resource group: `gtmgrid-signing` (new). Region: pick one near you, e.g.
     **East US** or **West Europe**. Name: `gtmgrid-signing`. SKU: **Basic** is fine.
   - → this name is **`AZURE_TRUSTED_SIGNING_ACCOUNT`**.
2. Open the account → **Overview**. The **Account URI** (e.g.
   `https://eus.codesigning.azure.net/`) is **`AZURE_TRUSTED_SIGNING_ENDPOINT`**.
3. Left nav → **Identity validation** → start it.
   - **Individual**: government-ID based, usually fast.
   - **Organization**: requires the org to be 3+ years old; slower.
4. Once validation succeeds → **Certificate profiles** → **Create**. Type
   **Public Trust**. Give it a name, e.g. `gtmgrid-profile`.
   - → this name is **`AZURE_TRUSTED_SIGNING_PROFILE`**.

### B. CI credentials → gives you the 3 **Secrets** (one CLI command)
```bash
# Scope the signer role to the account you just made.
SUB=$(az account show --query id -o tsv)
az ad sp create-for-rbac \
  --name "gtmgrid-trusted-signing-ci" \
  --role "Trusted Signing Certificate Profile Signer" \
  --scopes "/subscriptions/$SUB/resourceGroups/gtmgrid-signing/providers/Microsoft.CodeSigning/codeSigningAccounts/gtmgrid-signing"
```
The JSON it prints maps directly:
- `tenant`   → **`AZURE_TENANT_ID`**
- `appId`    → **`AZURE_CLIENT_ID`**
- `password` → **`AZURE_CLIENT_SECRET`**  (shown once — copy it now)

> No `az`? Install: `brew install azure-cli`, then `az login`.

### C. Load all six into GitHub (run from the repo)
```bash
# Secrets
gh secret set AZURE_TENANT_ID     --body "<tenant>"
gh secret set AZURE_CLIENT_ID     --body "<appId>"
gh secret set AZURE_CLIENT_SECRET --body "<password>"
# Variables
gh variable set AZURE_TRUSTED_SIGNING_ENDPOINT --body "https://eus.codesigning.azure.net/"
gh variable set AZURE_TRUSTED_SIGNING_ACCOUNT  --body "gtmgrid-signing"
gh variable set AZURE_TRUSTED_SIGNING_PROFILE  --body "gtmgrid-profile"
```
After this, the next release signs automatically (`HAS_WINDOWS_SIGNING` flips true).

## How it works in `release.yml`
- `HAS_WINDOWS_SIGNING` is true only when the three Azure secrets exist.
- On the Windows build job (and only then), the **Configure Windows signing** step
  `cargo install`s `trusted-signing-cli` and injects a Tauri
  `bundle.windows.signCommand` into `tauri.conf.json`.
- Tauri invokes that command for the app `.exe` and the NSIS installer during the
  build; `trusted-signing-cli` authenticates via the `AZURE_*` env (passed to
  `tauri-action`) and signs + timestamps each file through the Trusted Signing API.

## Verifying a signed build
Download `GTM.Grid_<version>_x64-setup.exe` on Windows and either:
- Right-click → **Properties → Digital Signatures** (a signature should be listed), or
- `signtool verify /pa /v GTM.Grid_<version>_x64-setup.exe` (PowerShell).

SmartScreen reputation for a brand-new certificate still builds over download
volume; signing removes the "unknown publisher" block and is what lets Defender
trust the binary.
