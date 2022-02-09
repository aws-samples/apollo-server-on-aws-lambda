import { generateApolloCompatibleEventFromWebsocketEvent, generateLambdaProxyResponse } from './utils';

const { ApolloServer, gql } = require('apollo-server-lambda');
const { makeExecutableSchema } = require('@graphql-tools/schema');

const { parse, validate } = require('graphql');

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const dynamoDbClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: '2012-08-10',
  region: process.env.AWS_REGION,
});

const gatewayClient = new AWS.ApiGatewayManagementApi({
  apiVersion: '2018-11-29',
  endpoint: process.env.API_GATEWAY_ENDPOINT,
});

const eventBridge = new AWS.EventBridge({
  region: process.env.AWS_REGION,
});

const REQUEST_EVENT_DETAIL_TYPE = process.env.REQUEST_EVENT_DETAIL_TYPE!;

// Construct a schema, using GraphQL schema language
const typeDefs = gql`
  type EventDetails {
    EventId: String
    ErrorMessage: String
    ErrorCode: String
  }

  type Mutation {
    putEvent(message: String!, chatId: String!): Result
  }

  type Query {
    getEvent: String
  }

  type Result {
    Entries: [EventDetails]
    FailedEntries: Int
  }

  type Subscription {
    chat(chatId: String!): String
  }

  schema {
    query: Query
    mutation: Mutation
    subscription: Subscription
  }
`;

// Provide resolver functions for your schema fields

const resolvers = {
  Mutation: {
    // tslint:disable-next-line:no-any
    putEvent: async (_: any, { message, chatId }: any) => eventBridge.putEvents({
      Entries: [
        {
          EventBusName: process.env.BUS_NAME,
          Source: 'apollo',
          DetailType: REQUEST_EVENT_DETAIL_TYPE,
          Detail: JSON.stringify({
            message,
            chatId,
          }),
        },
      ],
    }).promise(),
  },
  Query: {
    getEvent: () => 'Hello from Apollo!',
  },
};
const schema = makeExecutableSchema({ typeDefs, resolvers });

const server = new ApolloServer({
  schema,
});

const mutationAndQueryHandler = server.createHandler();

export async function handleMessage(event: any): Promise<any> {
  const operation = JSON.parse(event.body.replace(/\n/g, ''));
  const graphqlDocument = parse(operation.query);
  const validationErrors = validate(schema, graphqlDocument);
  const isWsConnection: boolean = !event.resource;

  if (validationErrors.length > 0) {
    if (isWsConnection) {
      await gatewayClient.postToConnection({
        ConnectionId: event.requestContext.connectionId,
        Data: JSON.stringify(validationErrors),
      }).promise();
    }

    return generateLambdaProxyResponse(400, JSON.stringify(validationErrors));
  }

  if (graphqlDocument.definitions[0].operation === 'subscription') {
    if (!isWsConnection) {
      return generateLambdaProxyResponse(400, 'Subscription not support via REST');
    }
    const { connectionId } = event.requestContext;
    const chatId: string = graphqlDocument.definitions[0].selectionSet.selections[0].arguments[0].value.value;

    const oneHourFromNow = Math.round(Date.now() / 1000 + 3600);
    await dynamoDbClient.put({
      TableName: process.env.TABLE_NAME!,
      Item: {
        chatId,
        connectionId,
        ttl: oneHourFromNow,
      },
    }).promise();

    return generateLambdaProxyResponse(200, 'Ok');
  }

  if (isWsConnection) {
    const response = await mutationAndQueryHandler(generateApolloCompatibleEventFromWebsocketEvent(event));
    await gatewayClient.postToConnection({
      ConnectionId: event.requestContext.connectionId,
      Data: response.body,
    }).promise();

    return response;
  }

  return mutationAndQueryHandler(event);
}
