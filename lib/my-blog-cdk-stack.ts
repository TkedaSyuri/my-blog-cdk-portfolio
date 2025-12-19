import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as rds from "aws-cdk-lib/aws-rds";
import * as logs from "aws-cdk-lib/aws-logs";
import { aws_lambda as lambda } from "aws-cdk-lib";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";

const PREFIX = "my-blog";

export class MyBlogCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //既存のvpc、subnetを追加
    const vpc = ec2.Vpc.fromVpcAttributes(this, `${PREFIX}-vpc`, {
      vpcId: "vpc-0a9692cdbcbb34ced",
      availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
      publicSubnetIds: [
        "subnet-0f16c0607103ece16", // my-blog-public-subnet-a
        "subnet-0527fd9c2cbf24254", // my-blog-public-subnet-c
      ],

      privateSubnetIds: [
        "subnet-0fa7e7110025d4f73", // my-blog-private-subnet-a
        "subnet-058e941b484972494", // my-blog-private-subnet-c
      ],
      vpcCidrBlock: "10.0.0.0/20",
    });

    const publicSubnetA = ec2.Subnet.fromSubnetId(
      this,
      "PublicSubnetA",
      "subnet-0f16c0607103ece16"
    );
    const publicSubnetC = ec2.Subnet.fromSubnetId(
      this,
      "PublicSubnetC",
      "subnet-0527fd9c2cbf24254"
    );
    const privateSubnetA = ec2.Subnet.fromSubnetId(
      this,
      "PrivateSubnetA",
      "subnet-0fa7e7110025d4f73"
    );

    const privateSubnetC = ec2.Subnet.fromSubnetId(
      this,
      "PrivateSubnetC",
      "subnet-058e941b484972494"
    );

    // 既存のセキュリティグループをインポート

    // my-blog-alb-sgをインポート
    const albSG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedAlbSG",
      "sg-0d42c5ce2575e9c51" // my-blog-alb-sg
    );

    //  my-blog-frontend-sgをインポート
    const frontendSG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedFrontendSG",
      "sg-051b9e9859fc1bc35"
    );

    // my-blog-frontend-sgのリソースにmy-blog-alb-sgをアタッチ
    frontendSG.addIngressRule(
      albSG,
      ec2.Port.tcp(3000),
      "Allow ALB to reach Frontend tasks on port 3000"
    );

    // Backend 用 SGをインポート
    const backendSG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedBackendSG",
      "sg-04349116049a9c696" // my-blog-backend-sg
    );
    // my-blog-backend-sgのリソースにmy-blog-front-sgをアタッチ
    backendSG.addIngressRule(
      frontendSG,
      ec2.Port.tcp(8080),
      "Allow Frontend containers to reach Backend containers on port 8080"
    );

    // my-blog-db-sgをインポート
    const proxySG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedProxySG",
      "sg-0fc560f4882c31b32"
    );

    // my-blog-db-sgをインポート
    const dbSG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedDbSG",
      "sg-0c103a71a76c8498e"
    );

    dbSG.addIngressRule(
      backendSG,
      ec2.Port.tcp(5432),
      "Allow Backend to reach DB on port 5432"
    );

    // VPC Endpoint 用 SG
    const endpointSG = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedEndpointSG",
      "sg-098e0afa63ed3251c"
    );

    // Frontend TG を作成
    const frontendTG = new elbv2.ApplicationTargetGroup(this, "FrontendTG", {
      targetGroupName: `${PREFIX}-tg`,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/",
        port: "3000",
      },
    });

    // ECR API VPCエンドポイントを作成
    new ec2.InterfaceVpcEndpoint(this, "EcrApiEndpoint", {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(
        "com.amazonaws.ap-northeast-1.ecr.api",
        443
      ),
      subnets: { subnets: [privateSubnetA, privateSubnetC] },
      securityGroups: [endpointSG],
      privateDnsEnabled: true,
    });

    // ECR DKR VPCエンドポイントを作成
    new ec2.InterfaceVpcEndpoint(this, "EcrDkrEndpoint", {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(
        "com.amazonaws.ap-northeast-1.ecr.dkr",
        443
      ),
      subnets: { subnets: [privateSubnetA, privateSubnetC] },
      securityGroups: [endpointSG],
      privateDnsEnabled: true,
    });

    // CloudWatch Logs VPCエンドポイントを作成
    new ec2.InterfaceVpcEndpoint(this, "LogsEndpoint", {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(
        "com.amazonaws.ap-northeast-1.logs",
        443
      ),
      subnets: { subnets: [privateSubnetA, privateSubnetC] },
      securityGroups: [endpointSG],
      privateDnsEnabled: true,
    });

    // SSM VPCエンドポイントを作成
    new ec2.InterfaceVpcEndpoint(this, "SSMEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnets: [privateSubnetA, privateSubnetC] },
      securityGroups: [endpointSG],
      privateDnsEnabled: true,
    });

    //dbのサブネットグループ
    const subnetGroup = new rds.SubnetGroup(this, "MySubnetGroup", {
      description: "Subnet group for single AZ RDS",
      vpc,
      vpcSubnets: {
        subnets: [privateSubnetA, privateSubnetC],
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    //既存のrds proxyをインポート
    const rdsProxy = rds.DatabaseProxy.fromDatabaseProxyAttributes(
      this,
      "ImportedProxy",
      {
        dbProxyName: "my-blog-db-proxy",
        dbProxyArn:
          "arn:aws:rds:ap-northeast-1:047719644594:db-proxy:prx-02d35a8c63cfd6848",
        endpoint:
          "my-blog-db-proxy.proxy-cd20mmqc4v1w.ap-northeast-1.rds.amazonaws.com",
        securityGroups: [proxySG],
      }
    );

    // RDS インスタンスをスナップショットから復元
    const dbInstance = new rds.DatabaseInstanceFromSnapshot(
      this,
      "MyRestoredDb",
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_17_4,
        }),
        snapshotIdentifier: "test-db-snapshot",
        vpc,
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.MICRO
        ),
        multiAz: false,
        allocatedStorage: 20,
        publiclyAccessible: false,
        vpcSubnets: {
          subnets: [privateSubnetA],
        },
        subnetGroup,
        deleteAutomatedBackups: true,
        securityGroups: [dbSG],
      }
    );
    dbInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    //既存のパラメータ(DBホスト)
    const dbHostParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "ImportedDbHostParam",
      {
        parameterName: "/my-blog/db/host",
      }
    );

    // 既存のパラメータ(DBパスワード)
    const dbPasswordParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "ImportedDbPasswordParam",
        {
          parameterName: "/my-blog/db/password",
        }
      );

    // 既存のパラメータ(DBの名前)
    const dbNameParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "ImportedDbNameParam",
      {
        parameterName: "/my-blog/db/name",
      }
    );

    // 既存のパラメータ(DBのユーザー)
    const dbUserParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "ImportedDbUserParam",
      {
        parameterName: "/my-blog/db/user",
      }
    );
    // 既存のパラメータ(DBのsecret-key-base)
    const dbSecretKeyBaseParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "ImportedDbSecretKeyBaseParam",
        {
          parameterName: "/my-blog/db/secret-key-base",
        }
      );

    // DB を Proxy に関連付けるカスタムリソースLambda関数
    const registerDbToProxy = new AwsCustomResource(this, "RegisterDbToProxy", {
      onCreate: {
        service: "RDS",
        action: "registerDBProxyTargets",
        parameters: {
          DBProxyName: "my-blog-db-proxy",
          DBInstanceIdentifiers: [dbInstance.instanceIdentifier],
        },
        physicalResourceId: PhysicalResourceId.of("RegisterDbProxyTarget"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    // proxy の登録処理が DB インスタンスの作成完了後に動く
    registerDbToProxy.node.addDependency(dbInstance);

    //既存のLamdbdaのロール(secrets managerに対するアクセス)
    const UpdatedSecretsMnagerLambdaRole = iam.Role.fromRoleArn(
      this,
      "ExistingLambdaRole",
      "arn:aws:iam::047719644594:role/UpdatedSecretsMnagerLambdaRole",
      {
        mutable: false,
      }
    );

    // Secrets Manager のホスト値を更新するlambda関数
    const updateSecretLambda = new lambda.Function(this, "UpdateSecretLambda", {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/update-secret"),
      role: UpdatedSecretsMnagerLambdaRole,
      environment: {
        SECRET_ID:
          "arn:aws:secretsmanager:ap-northeast-1:047719644594:secret:prod/myBlog/Postgres-MDa1Qr",
        DB_ENDPOINT: dbInstance.dbInstanceEndpointAddress,
      },
    });

    const updateSecretCustomResource = new AwsCustomResource(
      this,
      "UpdateSecretCustomResource",
      {
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: updateSecretLambda.functionName,
            InvocationType: "Event",
            Payload: JSON.stringify({
              DB_ENDPOINT: dbInstance.dbInstanceEndpointAddress,
              SECRET_ID:
                "arn:aws:secretsmanager:ap-northeast-1:047719644594:secret:prod/myBlog/Postgres-MDa1Qr",
            }),
          },
          physicalResourceId: PhysicalResourceId.of(
            "UpdateSecretLambdaInvocation"
          ),
        },

        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"], 
            resources: [updateSecretLambda.functionArn],
            effect: iam.Effect.ALLOW,
          }),
        ]),
      }
    );

    // RDS作成完了後にCustom Resourceが呼ばれるよう依存関係を設定
    updateSecretCustomResource.node.addDependency(dbInstance);

    //既存のACMの証明書をインポート
    const certArn =
      "arn:aws:acm:ap-northeast-1:047719644594:certificate/f50988de-ae1d-4553-8579-b548d78c99be";
    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this,
      "BlogCert",
      certArn
    );

    //フロントエンドと接続するALBを作成
    const alb = new elbv2.ApplicationLoadBalancer(this, "MyBlogALB", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnets: [publicSubnetA, publicSubnetC] },
      loadBalancerName: `${PREFIX}-alb`,
      securityGroup: albSG,
    });

    //albのリスナー
    const listener = alb.addListener("HttpListener", {
      port: 443,
      certificates: [certificate],
      open: true,
    });

    listener.addTargetGroups("AttachFrontendTG", {
      targetGroups: [frontendTG],
    });

    // ALB の全リクエストを Frontend TG にフォワード
    listener.addAction("DefaultRouteToFrontend", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/*"])],
      action: elbv2.ListenerAction.forward([frontendTG]),
    });

    // 4. Route53のホストゾーンから取得し、エイリアスAレコード作成
    const hostedZone = route53.HostedZone.fromLookup(this, "BlogHostedZone", {
      domainName: "syuri-takeda.jp",
    });

    new route53.ARecord(this, "BlogAliasRecord", {
      zone: hostedZone,
      recordName: "blog", // => blog.syuri-takeda.jp
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(alb)
      ),
    });
    //名前空間をインポート
    const myBlogNamespace =
      servicediscovery.PrivateDnsNamespace.fromPrivateDnsNamespaceAttributes(
        this,
        "ImportedNamespace",
        {
          namespaceId: "ns-ll72yudx435py4o3",
          namespaceName: "my-blog-cluster",
          namespaceArn:
            "arn:aws:servicediscovery:ap-northeast-1:047719644594:namespace/ns-ll72yudx435py4o3",
        }
      );

    // 既存 ECR リポジトリをインポート
    const frontendRepo = ecr.Repository.fromRepositoryName(
      this,
      "ImportedFrontendEcr",
      "my-blog-frontend"
    );
    const backendRepo = ecr.Repository.fromRepositoryName(
      this,
      "ImportedBackendEcr",
      "my-blog-backend"
    );
    // ECS クラスター
    const cluster = new ecs.Cluster(this, "MyBlogCluster", {
      vpc,
      clusterName: `${PREFIX}-cluster`,
    });

    // タスク実行ロール
    const executionRole = iam.Role.fromRoleArn(
      this,
      "ImportedEcsTaskExecutionRole",
      "arn:aws:iam::047719644594:role/ecsTaskExecutionRole"
    );

    //バックエンドのロググループ作成
    const backendLogGroup = new logs.LogGroup(this, "BackendLogGroup", {
      logGroupName: "/ecs/my-blog-backend",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Backend タスク定義
    const backendTaskDef = new ecs.FargateTaskDefinition(
      this,
      "BackendTaskDef",
      {
        family: "my-blog-backend-taskdef",
        cpu: 512,
        memoryLimitMiB: 1024,
        executionRole,
      }
    );

    const backendContainer = backendTaskDef.addContainer("BackendContainer", {
      image: ecs.ContainerImage.fromEcrRepository(backendRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${PREFIX}-backend`,
        logGroup: backendLogGroup,
      }),
      secrets: {
        DB_HOST: ecs.Secret.fromSsmParameter(dbHostParam),
        DB_NAME: ecs.Secret.fromSsmParameter(dbNameParam),
        DB_USER: ecs.Secret.fromSsmParameter(dbUserParam),
        DB_PASSWORD: ecs.Secret.fromSsmParameter(dbPasswordParam),
        SECRET_KEY_BASE: ecs.Secret.fromSsmParameter(dbSecretKeyBaseParam),
      },
    });

    backendContainer.addPortMappings({
      name: "backend",
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
    });

    //backendのサービス作成
    const backendService = new ecs.FargateService(this, "BackendService", {
      serviceName: `${PREFIX}-backend-service`,
      cluster,
      taskDefinition: backendTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnets: [privateSubnetA] },
      securityGroups: [backendSG],
      serviceConnectConfiguration: {
        namespace: "my-blog-cluster",
        services: [
          {
            portMappingName: "backend",
            discoveryName: "backend",
          },
        ],
      },
    });

    //Lambda(secrets manager hostの値を書き換える処理)の実行が完了されてから構築されるよう依存関係を指定
    backendService.node.addDependency(updateSecretCustomResource);

    //フロントエンドのロググループ作成
    const frontendLogGroup = new logs.LogGroup(this, "FrontendLogGroup", {
      logGroupName: "/ecs/my-blog-frontend",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Frontend タスク定義
    const frontendTaskDef = new ecs.FargateTaskDefinition(
      this,
      "FrontendTaskDef",
      {
        family: "my-blog-frontend-taskdef",
        cpu: 512,
        memoryLimitMiB: 1024,
        executionRole,
      }
    );

    const frontendContainer = frontendTaskDef.addContainer(
      "FrontendContainer",
      {
        image: ecs.ContainerImage.fromEcrRepository(frontendRepo, "latest"),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `${PREFIX}-frontend`,
          logGroup: frontendLogGroup,
        }),
        environment: {
          API_URL: process.env.API_URL!,
        },
      }
    );

    // Frontend ポートマッピング
    frontendContainer.addPortMappings({
      name: "frontend",
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
    });

    const frontendService = new ecs.FargateService(this, "FrontendService", {
      serviceName: `${PREFIX}-frontend-service`,
      cluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnets: [privateSubnetA] },
      securityGroups: [frontendSG],
      serviceConnectConfiguration: {
        namespace: "my-blog-cluster",
      },
    });
    //バックエンドが作成されてから起動するよう依存関係を指定
    frontendService.node.addDependency(backendService);

    // Frontend TG にサービス登録 (port 3000)
    frontendTG.addTarget(frontendService);
  }
}
