terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Zips the Slack-forwarder lambda source at plan time (alerts.tf).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Bucket/table are created by terraform/bootstrap. Values are supplied by
  # `terraform init -backend-config=...` (the workflow does this) so the
  # account id never has to be hardcoded here.
  backend "s3" {
    key            = "pipeline-radar/app.tfstate"
    region         = "us-east-1"
    dynamodb_table = "pipeline-radar-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project = var.project
      Env     = var.env_name
    }
  }
}
