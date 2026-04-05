# Getting Started — How to put AI Audit Ledger live

This guide is written for someone with no cloud or coding background. Follow the steps in order. Each one builds on the last.

By the end you will have a live system that can receive AI decision records, store them securely, and let you read them back through the dashboard.

**Total time:** About 1–2 hours, mostly waiting for things to install and deploy.

---

## What you are setting up

Think of it like opening a new office:

- **AWS** is the building you are renting space in (Amazon's cloud)
- **Node.js** is a tool your computer needs to prepare the paperwork
- **AWS CLI** is the phone line between your computer and that building
- **The deploy** is the moment you hand over the paperwork and the office opens for business

---

## Before you start — what you need

- A computer running Windows
- An email address (for the AWS account)
- A credit card (AWS charges for usage — expect roughly £5–15 per month at normal volumes)
- An internet connection

---

## Step 1 — Create an AWS account

AWS (Amazon Web Services) is where your system will live. Think of it as renting space on Amazon's computers rather than buying your own server.

1. Open your browser and go to **aws.amazon.com**
2. Click **Create an AWS Account** (top right corner)
3. Enter your email address and choose a password
4. You will be asked for:
   - Your name and address
   - A credit card (you will not be charged during setup — only once the system is running)
   - A phone number to verify your identity (they will call or text you with a code)
5. When asked to choose a **Support Plan**, select **Basic support — Free**. You do not need a paid support plan.
6. Once signup is complete, click **Go to the AWS Management Console**

You are now inside the AWS Console — a webpage with a long list of services. It looks complicated but you do not need to click anything here yet.

> **Keep your AWS login details safe.** Store them in a password manager. Anyone with access to your AWS account can create services that cost money.

---

## Step 2 — Install Node.js

Node.js is a tool your computer needs to run the deployment script. Think of it as installing a piece of software that speaks the language the deploy script is written in.

1. Open your browser and go to **nodejs.org**
2. You will see two download buttons. Click the one labelled **LTS** (this stands for Long Term Support — it is the stable, recommended version)
3. Run the downloaded file (it will be named something like `node-v20.x.x-x64.msi`)
4. Click through the installer — the default options are all correct, just keep clicking **Next** and then **Install**
5. When it finishes, click **Finish**

**Check it worked:**
1. Press the **Windows key**, type `cmd`, and press Enter — this opens a black Command Prompt window
2. Type the following and press Enter:
   ```
   node --version
   ```
3. It should print a version number like `v20.11.0`. If it does, Node.js is installed correctly.

---

## Step 3 — Install the AWS CLI

The AWS CLI is a small program that lets your computer send instructions to AWS. Think of it as installing the phone line between your machine and the cloud.

1. Open your browser and go to:
   **docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html**
2. Under the **Windows** section, click the link to download the installer (it ends in `.msi`)
3. Run the downloaded file and click through the installer — defaults are all correct
4. When it finishes, **close and reopen** your Command Prompt window (this is important — the old window will not know the new program exists)

**Check it worked:**
In the new Command Prompt window, type:
```
aws --version
```
It should print something like `aws-cli/2.15.0`. If it does, the AWS CLI is installed.

---

## Step 4 — Connect your computer to your AWS account

Right now your computer has the tools installed but does not know which AWS account to talk to. This step links them.

You will need to create a set of **access keys** — think of these as a username and password that your computer uses to talk to AWS on your behalf.

**Create access keys:**
1. Go back to the AWS Console in your browser (aws.amazon.com, sign in if needed)
2. Click your account name in the top right corner
3. Click **Security credentials**
4. Scroll down to the **Access keys** section
5. Click **Create access key**
6. When asked what you will use it for, select **Command Line Interface (CLI)**
7. Tick the confirmation box and click **Next**, then **Create access key**
8. You will see an **Access key ID** and a **Secret access key** — **copy both now**. You will not be able to see the secret key again after closing this page.

> Store these somewhere safe — a password manager is ideal. Do not share them or put them in a document that others can see.

**Link them to your computer:**
1. Open Command Prompt
2. Type the following and press Enter:
   ```
   aws configure
   ```
3. It will ask you four questions — answer them one at a time:
   - **AWS Access Key ID:** paste the access key ID you just copied
   - **AWS Secret Access Key:** paste the secret access key
   - **Default region name:** type `eu-west-1` (Ireland — a good default for EU compliance)
   - **Default output format:** type `json`

Your computer is now connected to your AWS account.

---

## Step 5 — Install the deployment tool

The deployment tool (called CDK) is what reads the project blueprint and creates everything in AWS. You only install this once.

In Command Prompt, type:
```
npm install -g aws-cdk
```
Wait for it to finish. It may take a minute.

**Check it worked:**
```
cdk --version
```
It should print a version number.

---

## Step 6 — Prepare the project

Navigate to the project folder and install its dependencies:

```
cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
npm install
```

This downloads the software libraries the project needs. It does not create anything in AWS yet.

---

## Step 7 — One-time AWS preparation (bootstrap)

The very first time you use CDK in an AWS account, you need to run a one-time setup command. Think of it as preparing the office building before you can move furniture in.

```
npx cdk bootstrap
```

This takes about 2 minutes. You only ever do this once per AWS account.

---

## Step 8 — Choose your API keys

Before going live you need to decide on the secret passwords (API keys) for your system. There are two types:

- **Tenant keys** — given to customers who send AI decision records to your system. Each customer gets their own unique key.
- **Read key** — given to people who need to read the records (for example, you, your compliance team, or the dashboard).

**Rules for good keys:**
- Use long, random strings — at least 32 characters
- Mix letters and numbers
- Never use real words or company names
- Example of a good key: `f7k2mXpQ9nRsT4wYv8hLjC3dEuA6bN1`

You can generate random keys at **passwordsgenerator.net** — set length to 40, include letters and numbers, exclude symbols.

Write your keys down and store them safely before moving to the next step.

---

## Step 9 — Deploy (go live)

This is the moment everything goes live. Run the following command in Command Prompt, replacing the example keys with your own:

**On Windows Command Prompt:**
```
npx cdk deploy --context tenantKeyMap="{\"customer-one-key\":\"customer-one\"}" --context readKeyMap="{\"your-read-key\":\"*\"}"
```

If you have multiple customers, list them all:
```
npx cdk deploy --context tenantKeyMap="{\"customer-one-key\":\"customer-one\",\"customer-two-key\":\"customer-two\"}" --context readKeyMap="{\"your-read-key\":\"*\"}"
```

- It will ask **"Do you wish to deploy these changes?"** — type `y` and press Enter
- The deploy takes approximately 5–10 minutes
- You will see progress messages in the terminal — this is normal

---

## Step 10 — Save your outputs

When the deploy finishes, it prints a list of important addresses and names. **Copy all of these and save them somewhere safe** — you will need them.

The key ones are:

| What it says | What it means | What to do with it |
|---|---|---|
| **IngestUrl** | The address customers send records to | Give this to each customer along with their tenant key |
| **ReadUrl** | The address for reading records | You use this — it also goes in the dashboard |
| **ApiBaseUrl** | The main API address | Useful for reference |
| **TenantKeySecretArn** | Location of your customer keys in the vault | Note this in case you need to add/remove customers later |
| **ReadKeySecretArn** | Location of your read keys in the vault | Note this in case you need to change read access |

---

## Step 11 — Open the dashboard

1. Find the file `dashboard\index.html` in the project folder
2. Double-click it — it opens in your browser
3. Paste in your **ApiBaseUrl** and your **read key**
4. Click **Connect**

You should see the log table. It will be empty until someone sends the first record — that is expected.

---

## You are live

Your system is now running. Here is a summary of what exists:

- A public web address that customers can send AI decision records to
- A secure vault holding all API keys (not stored anywhere visible)
- A tamper-resistant logbook that stores every record permanently
- A rate limiter that prevents any one customer from overwhelming the system
- A dashboard you can open to browse, inspect, and export records

---

## Adding a new customer later

When you sign up a new customer:

1. Generate a new random key for them (see Step 8 for how)
2. Go to the AWS Console → **Secrets Manager** → find `ai-audit-ledger/tenant-key-map`
3. Click **Retrieve secret value**, then **Edit**
4. Add a new line in the format: `"their-new-key": "their-company-name"`
5. Click **Save**

The system picks up the new key within seconds. No redeployment needed.

---

## Removing a customer

Same steps as adding, but delete their line from the secret instead of adding one.

---

## Monthly running costs (approximate)

| Service | What it does | Approx. monthly cost |
|---|---|---|
| API Gateway | Receives requests | < £1 at low volume |
| Lambda | Runs the code | Usually free tier |
| SQS | The queue | Usually free tier |
| DynamoDB | Searchable index + rate limiting | < £2 at low volume |
| S3 Object Lock | Permanent sealed archive | < £2 depending on storage |
| Secrets Manager | Key vault | < £1 |
| **Total** | | **~£3–8/month** |

Costs rise with volume but remain low until you have many active customers sending thousands of records per day.

---

## If something goes wrong

| What you see | What to try |
|---|---|
| Error during `npm install` | Make sure you are in the right folder: `cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"` |
| Bootstrap error | Make sure `aws configure` was completed successfully and your keys have the right permissions |
| Deploy fails with "not authorised" | Your AWS access keys may need broader permissions — ask the AWS account owner |
| Dashboard says "Could not reach the API" | Check the URL has no trailing slash and starts with `https://` |
| Dashboard says "Invalid API key" | Double-check you are using the read key, not a tenant key |

For anything else, your technical contact will need to look at the error message in detail.
