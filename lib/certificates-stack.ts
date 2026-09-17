import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { HOSTED_ZONE_ID, ZONE_NAME } from './account';

export interface CertificatesStackProps extends cdk.StackProps {
  /** One entry per app: the construct id and the hostname it serves. */
  readonly domains: ReadonlyArray<{ readonly id: string; readonly domainName: string }>;
}

/**
 * ACM certificates for the ReconFlow hostnames.
 *
 * Separate stack because CloudFront only accepts certificates from us-east-1,
 * while everything else lives in ap-south-1. The app stacks read these across
 * regions via `crossRegionReferences`.
 *
 * Validation is DNS-based against the existing wingtheidea.com zone, so the
 * validation records are written for you — but `cdk deploy` will sit waiting
 * until ACM sees them, which is normally a few minutes.
 */
export class CertificatesStack extends cdk.Stack {
  public readonly certificates: Record<string, acm.ICertificate> = {};

  constructor(scope: Construct, id: string, props: CertificatesStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });

    for (const { id: certId, domainName } of props.domains) {
      this.certificates[domainName] = new acm.Certificate(this, certId, {
        domainName,
        certificateName: domainName,
        validation: acm.CertificateValidation.fromDns(zone),
      });
    }
  }
}
