# syntax = docker/dockerfile:1
ARG BASE_IMAGE=node:lts-slim
FROM ${BASE_IMAGE}
ARG PI_AGENT_VERSION
RUN test -n "$PI_AGENT_VERSION" \
 && npm install -g @mariozechner/pi-coding-agent@${PI_AGENT_VERSION}
