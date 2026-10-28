FROM golang:1.26.10-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ \
    ./cmd/api ./cmd/wallet-migrate ./cmd/inventory-migrate \
    ./cmd/economy-cutover ./cmd/workshop-worker ./cmd/runtime-grants ./cmd/treasury-open \
    ./cmd/account-restrict ./cmd/restriction-expire

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /
COPY --from=build /src/config /config
ENV ECONOMY_CONFIG=/config/economy.json
ENV SECURITY_POLICY_FILE=/config/security.json
ENV TRANSFER_CONFIG=/config/transfers.json
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/api"]
