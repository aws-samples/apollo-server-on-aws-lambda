import { Runtime, Tracing } from '@aws-cdk/aws-lambda';
import { HttpMethod, WebSocketApi, WebSocketStage } from '@aws-cdk/aws-apigatewayv2';
import {
  App, CfnOutput, Construct, RemovalPolicy, Stack, StackProps,
} from '@aws-cdk/core';
import {
  AttributeType, BillingMode, ProjectionType, Table,
} from '@aws-cdk/aws-dynamodb';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { EventBus, Rule } from '@aws-cdk/aws-events';
import { Duration } from '@aws-cdk/core/lib/duration';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { LambdaWebSocketIntegration } from '@aws-cdk/aws-apigatewayv2-integrations';
import path = require('path');
import { LambdaIntegration, RestApi } from '@aws-cdk/aws-apigateway';

export interface SimpleLambdaProps {
  memorySize?: number;
  reservedConcurrentExecutions?: number;
  runtime?: Runtime;
  name: string;
  description: string;
  entryFilename: string;
  handler?: string;
  timeout?: Duration;
  envVariables?: any;
}

export class SimpleLambda extends Construct {
  public fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SimpleLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, id, {
      entry: `../src/lambda/${props.entryFilename}`,
      handler: props.handler ?? 'handler',
      runtime: props.runtime ?? Runtime.NODEJS_14_X,
      timeout: props.timeout ?? Duration.seconds(5),
      memorySize: props.memorySize ?? 1024,
      tracing: Tracing.ACTIVE,
      functionName: props.name,
      description: props.description,
      depsLockFilePath: path.join(__dirname, '..', '..', 'src', 'package-lock.json'),
      environment: props.envVariables ?? {},
    });
  }
}

export class ApolloLambdaWebsocketStack extends Stack {
  private readonly webSocketApi: WebSocketApi;

  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const REQUEST_EVENT_DETAIL_TYPE = 'ClientMessageReceived';
    const RESPONSE_EVENT_DETAIL_TYPE = 'ClientMessageTranslated';

    const connectionTable = new Table(this, 'WebsocketConnections', {
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: 'WebsocketConnections',
      partitionKey: {
        name: 'chatId',
        type: AttributeType.STRING,
      },
      sortKey: {
        name: 'connectionId',
        type: AttributeType.STRING,
      },
    });

    const GSI_NAME = 'ConnectionIdMap';
    connectionTable.addGlobalSecondaryIndex({
      partitionKey: {
        name: 'connectionId',
        type: AttributeType.STRING,
      },
      sortKey: {
        name: 'chatId',
        type: AttributeType.STRING,
      },
      indexName: GSI_NAME,
      projectionType: ProjectionType.KEYS_ONLY,
    });

    const eventBus = new EventBus(this, 'ApolloMutationEvents', {
      eventBusName: 'ApolloMutationEvents',
    });

    const connectionLambda = new SimpleLambda(this, 'ConnectionHandler', {
      entryFilename: 'websocket-connection-handler.ts',
      handler: 'connectionHandler',
      name: 'ConnectionHandler',
      description: 'Handles the onConnect & onDisconnect events emitted by the WebSocket API GW',
      envVariables: {
        TABLE_NAME: connectionTable.tableName,
        GSI_NAME,
      },
    });

    connectionTable.grantFullAccess(connectionLambda.fn);

    this.webSocketApi = new WebSocketApi(this, 'ApolloWebsocketApi', {
      apiName: 'WebSocketApi',
      description: 'A Websocket API that handles GraphQL queries',
      connectRouteOptions: {
        integration: new LambdaWebSocketIntegration({
          handler: connectionLambda.fn,
        }),
      },
      disconnectRouteOptions: {
        integration: new LambdaWebSocketIntegration({
          handler: connectionLambda.fn,
        }),
      },
    });

    const websocketStage = new WebSocketStage(this, 'ApolloWebsocketStage', {
      webSocketApi: this.webSocketApi,
      stageName: 'dev',
      autoDeploy: true,
    });

    const requestHandlerLambda = new SimpleLambda(this, 'RequestHandler', {
      entryFilename: 'graphql-query-handler.ts',
      handler: 'handleMessage',
      name: 'RequestHandler',
      description: 'Handles GraphQL queries sent via websocket and REST. Stores (connectionId, topic) tuple in DynamoDB for subscriptions requests. Sends events to EventBridge for mutation requests',
      envVariables: {
        BUS_NAME: eventBus.eventBusName,
        TABLE_NAME: connectionTable.tableName,
        REQUEST_EVENT_DETAIL_TYPE,
        API_GATEWAY_ENDPOINT: websocketStage.callbackUrl,
      },
    });

    connectionTable.grantFullAccess(requestHandlerLambda.fn);
    eventBus.grantPutEventsTo(requestHandlerLambda.fn);

    requestHandlerLambda.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${websocketStage.stageName}/*`,
        ],
        actions: ['execute-api:ManageConnections'],
      }),
    );

    this.webSocketApi.addRoute('$default', {
      integration: new LambdaWebSocketIntegration({
        handler: requestHandlerLambda.fn,
      }),
    });

    const eventBridgeToSubscriptionsLambda = new SimpleLambda(this, 'ResponseHandler', {
      entryFilename: 'eventbus-response-handler.ts',
      handler: 'handler',
      name: 'ResponseHandler',
      description: `Gets invoked when a new response event (${RESPONSE_EVENT_DETAIL_TYPE}) is published to EventBridge, finds the interested subscribers and pushes the event via WebSocket`,
      envVariables: {
        BUS_NAME: eventBus.eventBusName,
        TABLE_NAME: connectionTable.tableName,
        API_GATEWAY_ENDPOINT: websocketStage.callbackUrl,
      },
    });

    const translateToFrenchLambda = new SimpleLambda(this, 'ProcessMutationEventLambda', {
      entryFilename: 'event-processor.ts',
      handler: 'translateMessage',
      name: 'TranslateToFrench',
      description: `Gets invoked when a new request event (${REQUEST_EVENT_DETAIL_TYPE}) is published to EventBridge. The function processes translates event.detail.message to French and publishes the result back to the event bus`,
      envVariables: {
        BUS_NAME: eventBus.eventBusName,
        RESPONSE_EVENT_DETAIL_TYPE,
        TARGET_LANGUAGE_CODE: 'fr',
      },
    });

    const translateToGermanLambda = new SimpleLambda(this, 'ProcessMutationEventLambda2', {
      entryFilename: 'event-processor.ts',
      handler: 'translateMessage',
      name: 'TranslateToGerman',
      description: `Gets invoked when a new request event (${REQUEST_EVENT_DETAIL_TYPE}) is published to EventBridge. The function processes translates event.detail.message to German and publishes the result back to the event bus`,
      envVariables: {
        BUS_NAME: eventBus.eventBusName,
        RESPONSE_EVENT_DETAIL_TYPE,
        TARGET_LANGUAGE_CODE: 'de',
      },
    });

    const allowUseOfAmazonTranslate = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [
        '*',
      ],
      actions: ['translate:TranslateText', 'comprehend:DetectDominantLanguage'],
    });
    translateToFrenchLambda.fn.addToRolePolicy(allowUseOfAmazonTranslate);
    translateToGermanLambda.fn.addToRolePolicy(allowUseOfAmazonTranslate);

    new Rule(this, 'ProcessRequest', {
      eventBus,
      enabled: true,
      ruleName: 'TranslateMessage',
      eventPattern: {
        detailType: [REQUEST_EVENT_DETAIL_TYPE],
      },
      targets: [
        new LambdaFunction(translateToFrenchLambda.fn),
        new LambdaFunction(translateToGermanLambda.fn),
      ],
    });

    new Rule(this, 'NotifyApolloSubscribers', {
      eventBus,
      enabled: true,
      ruleName: 'RespondToChat',
      eventPattern: {
        detailType: [RESPONSE_EVENT_DETAIL_TYPE],
      },
      targets: [
        new LambdaFunction(eventBridgeToSubscriptionsLambda.fn),
      ],
    });

    connectionTable.grantFullAccess(eventBridgeToSubscriptionsLambda.fn);

    eventBridgeToSubscriptionsLambda.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${websocketStage.stageName}/*`,
        ],
        actions: ['execute-api:ManageConnections'],
      }),
    );

    eventBus.grantPutEventsTo(translateToFrenchLambda.fn);
    eventBus.grantPutEventsTo(translateToGermanLambda.fn);
    eventBus.grantPutEventsTo(requestHandlerLambda.fn);

    const restApi = new RestApi(this, 'ApolloRestApi', {
      description: 'A Rest API that handles GraphQl queries via POST to /graphql.',
      deployOptions: {
        stageName: 'dev',
        tracingEnabled: true,
      },
      restApiName: 'RestApi',
    });

    restApi.root
      .addResource('graphql')
      .addMethod(HttpMethod.POST, new LambdaIntegration(requestHandlerLambda.fn));

    new CfnOutput(this, 'WebsocketApiEndpoint', {
      value: `${this.webSocketApi.apiEndpoint}/${websocketStage.stageName}`,
      exportName: 'WebsocketApiEndpoint',
    });

    new CfnOutput(this, 'RestApiEndpoint', {
      value: restApi.urlForPath('/graphql'),
      exportName: 'RestApiEndpoint',
    });
  }
}
