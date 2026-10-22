# Rate Limiter API Challenge

## Overview

Design and implement a rate limiter service that can be used to control the rate of requests to an API. This challenge tests your ability to design a system that handles concurrency, maintains state, and provides a clean API interface.

## Requirements

### Functional Requirements

1. Create a rate limiter service that limits the number of requests a client can make within a specified time window
2. The service should expose an HTTP API with the following endpoints:
   - `POST /api/v1/ratelimit` - Check if a request should be allowed or rejected based on rate limits
   - `POST /api/v1/configure` - Set or update the ratelimiting configuration
3. The rate limiter should support:
   - Different rate limits for different clients (identified by a client ID)
   - Configurable time window in seconds
   - Configurable request limits within those windows

### API Specification

#### POST /api/v1/ratelimit

Request:
```json
{
  "client_id": "string",
  "resource": "string"
}
```

Response (200 OK):
```json
{
  "allowed": true|false,
  "remaining": integer,
  "retry_after": integer (seconds, only present when allowed is false)
}
```

#### POST /api/v1/configure

Request:
```json
{
  "window_seconds": integer,
  "request_per_window": integer
}
```

Response (200 OK):
```json
{
  "window_seconds": integer,
  "request_per_window": integer
}
```

### Non-Functional Requirements

1. The service should be able to handle high throughput (1000+ requests per second)
2. The rate limiter should have low latency (< 10ms per decision)
3. The solution should be thread-safe and handle concurrent requests correctly
4. The code should be well-tested
5. The solution should include documentation on how to run and test the service

## Constraints

1. You can use any programming language of your choice
2. You can use any libraries or frameworks, but be prepared to justify your choices
3. The solution should not require external services (e.g., Redis, databases) to function, though you can design it to be extensible to use them
4. The rate limiter should work correctly on a single machine

## Evaluation Criteria

Your solution will be evaluated based on:

1. Correctness - Does it work as specified?
2. Design - Is the code well-structured and maintainable?
3. Performance - Does it meet the non-functional requirements?
4. Testing - Is the solution well-tested?
5. Documentation - Is the solution well-documented?

## Submission

Please provide:

1. Source code for your solution
2. Instructions on how to build and run your solution
3. A brief write-up explaining your design choices and any trade-offs you made

Good luck!
