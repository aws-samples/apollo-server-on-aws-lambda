import * as cdk from '@aws-cdk/core';

import { Tags } from '@aws-cdk/core';
import { ApolloLambdaWebsocketStack } from '../lib/apollo-lambda-websocket-stack';

const app = new cdk.App();

const stack = new ApolloLambdaWebsocketStack(app, 'ApolloLambdaWebsocketStack');
Tags.of(stack).add('project', 'aws-blogpost');
Tags.of(stack).add('topic', 'lambda-apollo-websockets-events');
