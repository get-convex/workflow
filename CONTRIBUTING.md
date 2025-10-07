# Developing guide

## Running locally

```sh
npm run setup
npm run dev
```

## Testing

```sh
npm run clean
npm run typecheck
npm run lint
npm run test
```

## Deploying

### Building a one-off package

```sh
npm run clean
npm run build
npm pack
```

### Deploying a new version

```sh
npm run release
```

#### Alpha release

```sh
npm run alpha
```
