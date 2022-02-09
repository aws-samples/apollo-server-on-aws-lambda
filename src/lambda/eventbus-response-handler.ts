import { EventBridgeEvent } from 'aws-lambda';

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

interface ResponseEventDetails {
  message: string;
  chatId: string;
}

async function getConnectionsSubscribedToTopic(chatId: string): Promise<any> {
  const { Items: connectionId } = await dynamoDbClient.query({
    TableName: process.env.TABLE_NAME!,
    KeyConditionExpression: 'chatId = :chatId',
    ExpressionAttributeValues: {
      ':chatId': chatId,
    },
  }).promise();

  return connectionId;
}

export async function handler(event: EventBridgeEvent<'EventResponse', ResponseEventDetails>): Promise<any> {
  const connections = await getConnectionsSubscribedToTopic(event.detail.chatId);
  const postToConnectionPromises = connections?.map((c: any) => gatewayClient.postToConnection({
    ConnectionId: c.connectionId,
    Data: JSON.stringify({ data: event.detail.message }),
  }).promise());
  await Promise.allSettled(postToConnectionPromises!);
  return true;
}
