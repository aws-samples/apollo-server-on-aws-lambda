import { APIGatewayProxyEvent } from 'aws-lambda';
import { generateLambdaProxyResponse } from './utils';

const { graphql, parse } = require('graphql');

export async function handler(event: APIGatewayProxyEvent): Promise<any> {
  const operation = JSON.parse(event.body!.replace(/\n/g, ''));
  const graphqlDocument = parse(operation.query);
  if (graphqlDocument.definitions[0].operation !== 'subscription') {
    return graphql.handler(event);
  }

  return generateLambdaProxyResponse(400, 'Not supported');
}
