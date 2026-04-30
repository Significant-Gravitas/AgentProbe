# Deploying AgentProbe to GKE

AgentProbe ships an opt-in build-and-deploy pipeline:

- [`Dockerfile`](../Dockerfile) — multi-stage Bun build, exposes `:7878`.
- [`infra/helm/agentprobe`](helm/agentprobe) — generic Helm chart.
- [`.github/workflows/build-deploy.yml`](../.github/workflows/build-deploy.yml) — builds, pushes to Google Artifact Registry, and runs `helm upgrade --install` against a GKE cluster.

The repository is public, so nothing here is tied to a specific GCP project, cluster, or domain. Environment-specific config (hostnames, GCP project IDs, etc.) lives exclusively in **GitHub Environment variables** — nothing environment-specific is ever committed.

## How environments work

Create one GitHub Environment per deployment target at **Settings → Environments** (e.g. `dev` and `prod`). Each environment has its own variable set. The workflow reads all config from `vars.*` scoped to the active environment, so:

- push to `main` → deploys to the `prod` environment automatically
- manual `workflow_dispatch` → choose `dev` or `prod` at run time
- a fork that hasn't configured any environment just sees a preflight warning and exits cleanly

## One-time GCP setup

Run these against the project that will host the cluster. Replace the placeholders with your own values.

```bash
PROJECT_ID=my-project
REGION=us-east1
REPO=agentprobe
SA=agentprobe-deploy
POOL=github-actions
PROVIDER=github
GH_OWNER=<your-github-org-or-user>
GH_REPO=AgentProbe

# Artifact Registry repository
gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID"

# Service account that GitHub Actions will impersonate
gcloud iam service-accounts create "$SA" \
    --project="$PROJECT_ID"

SA_EMAIL="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"

# Push to Artifact Registry + deploy to GKE
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/container.developer"

# Workload Identity Pool + Provider locked to this repo
gcloud iam workload-identity-pools create "$POOL" \
    --project="$PROJECT_ID" --location=global

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$POOL" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GH_OWNER}/${GH_REPO}'"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GH_OWNER}/${GH_REPO}"

echo "WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "DEPLOY_SERVICE_ACCOUNT=${SA_EMAIL}"
```

## Configure GitHub Environment variables

Go to **Settings → Environments**, open the target environment (e.g. `prod`), and set these variables:

### Required

| Variable | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `my-project` |
| `GCP_REGION` | `us-east1` |
| `GCP_ARTIFACT_REPOSITORY` | `agentprobe` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/123/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `agentprobe-deploy@my-project.iam.gserviceaccount.com` |
| `GKE_CLUSTER` | `my-gke-cluster` |
| `GKE_LOCATION` | `us-east1-b` |
| `K8S_NAMESPACE` | `agentprobe` |

### Optional — release config

| Variable | Default | Description |
| --- | --- | --- |
| `IMAGE_NAME` | `agentprobe` | Image name in Artifact Registry |
| `HELM_RELEASE` | `agentprobe` | Helm release name |
| `DEPLOY_BRANCH` | `main` | Branch that triggers auto-deploy |

### Optional — Helm overlay

These are assembled into a temporary values file at deploy time. Nothing environment-specific is committed to the repo.

| Variable | Description |
| --- | --- |
| `HELM_WI_GSA` | GSA email for the in-cluster ServiceAccount annotation (`iam.gke.io/gcp-service-account`) |
| `HELM_INGRESS_ENABLED` | `"true"` to create an Ingress resource |
| `HELM_INGRESS_HOST` | Hostname, e.g. `agentprobe.example.com` |
| `HELM_INGRESS_CLASS` | Ingress class (default: `gce`) |
| `HELM_INGRESS_TLS_SECRET` | TLS Secret name; omit to skip the TLS section |
| `HELM_CORS_ORIGINS` | `AGENTPROBE_SERVER_CORS_ORIGINS` value |
| `HELM_EXISTING_SECRET` | Name of the pre-created k8s Secret with runtime credentials (see below) |
| `HELM_AUTOSCALING_ENABLED` | `"true"` to enable HPA |
| `HELM_AUTOSCALING_MAX` | Max replicas (default: `3`) |
| `HELM_PDB_ENABLED` | `"true"` to enable PodDisruptionBudget |
| `HELM_PERSISTENCE_SIZE` | PVC size override, e.g. `5Gi` |
| `INGRESS_STATIC_IP_NAME` | Reserved Google global static IP name |
| `CLOUD_SQL_INSTANCE_CONNECTION_NAME` | Cloud SQL instance, e.g. `my-project:us-central1:my-instance` |
| `CLOUD_SQL_PROXY_IMAGE` | Override the Cloud SQL Proxy image |

No GitHub Actions secrets are required — the workflow uses Workload Identity Federation.

## Pre-create the runtime Secret

The chart never creates Secrets. Supply the credentials out of band before the first deploy:

```bash
kubectl create namespace agentprobe
kubectl create secret generic agentprobe-secrets \
    --namespace agentprobe \
    --from-literal=AGENTPROBE_SERVER_TOKEN="$(openssl rand -hex 32)" \
    --from-literal=OPEN_ROUTER_API_KEY='sk-or-...'
```

Then set `HELM_EXISTING_SECRET=agentprobe-secrets` in the GitHub Environment. For Postgres, also include `AGENTPROBE_DB_URL` and `AGENTPROBE_ENCRYPTION_KEY` keys in the Secret.

Reserve the static IP once before deploying (the workflow attaches it but does not create it):

```bash
gcloud compute addresses create agentprobe-prod-ip --global --project=$PROJECT_ID
```

Point your DNS A record at the address shown by `gcloud compute addresses describe agentprobe-prod-ip --global`.

## Deploy from your laptop

For one-off local deploys, pass overrides directly with `--set` or a local file you do **not** commit:

```bash
helm upgrade --install agentprobe ./infra/helm/agentprobe \
    --namespace agentprobe --create-namespace \
    --set image.repository=us-east1-docker.pkg.dev/my-project/agentprobe/agentprobe \
    --set image.tag=latest \
    --set ingress.enabled=true \
    --set "ingress.hosts[0].host=agentprobe.example.com" \
    --set secrets.existingSecretName=agentprobe-secrets
```
