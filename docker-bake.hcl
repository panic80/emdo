variable "REGISTRY" {
  default = "ghcr.io/panic80/emdo"
}

variable "SOURCE_SHA" {
  default = "dev"
}

variable "BUILD_CREATED" {
  default = "unknown"
}

group "default" {
  targets = ["api", "worker", "web"]
}

target "application" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
  args = {
    SOURCE_SHA    = SOURCE_SHA
    BUILD_CREATED = BUILD_CREATED
  }
  attest = [
    "type=provenance,mode=max",
    "type=sbom"
  ]
}

target "api" {
  inherits = ["application"]
  target   = "api"
  tags     = ["${REGISTRY}-api:sha-${SOURCE_SHA}"]
}

target "worker" {
  inherits = ["application"]
  target   = "worker"
  tags     = ["${REGISTRY}-worker:sha-${SOURCE_SHA}"]
}

target "web" {
  inherits = ["application"]
  target   = "web"
  tags     = ["${REGISTRY}-web:sha-${SOURCE_SHA}"]
}
