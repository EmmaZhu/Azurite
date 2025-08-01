import {
  BOOLEAN,
  DATE,
  INTEGER,
  literal,
  Model,
  Op,
  Options as SequelizeOptions,
  Sequelize,
  TEXT,
  Transaction,
  WhereOptions
} from "sequelize";

import uuid from "uuid/v4";

import {
  DEFAULT_SQL_CHARSET,
  DEFAULT_SQL_COLLATE
} from "../../common/utils/constants";
import { convertDateTimeStringMsTo7Digital } from "../../common/utils/utils";
import { newEtag } from "../../common/utils/utils";
import { validateReadConditions } from "../conditions/ReadConditionalHeadersValidator";
import { validateWriteConditions } from "../conditions/WriteConditionalHeadersValidator";
import StorageErrorFactory from "../errors/StorageErrorFactory";
import * as Models from "../generated/artifacts/models";
import Context from "../generated/Context";
import BlobLeaseAdapter from "../lease/BlobLeaseAdapter";
import BlobLeaseSyncer from "../lease/BlobLeaseSyncer";
import BlobReadLeaseValidator from "../lease/BlobReadLeaseValidator";
import BlobWriteLeaseSyncer from "../lease/BlobWriteLeaseSyncer";
import BlobWriteLeaseValidator from "../lease/BlobWriteLeaseValidator";
import ContainerDeleteLeaseValidator from "../lease/ContainerDeleteLeaseValidator";
import ContainerLeaseAdapter from "../lease/ContainerLeaseAdapter";
import ContainerLeaseSyncer from "../lease/ContainerLeaseSyncer";
import ContainerReadLeaseValidator from "../lease/ContainerReadLeaseValidator";
import { ILease } from "../lease/ILeaseState";
import LeaseFactory from "../lease/LeaseFactory";
import {
  DEFAULT_LIST_BLOBS_MAX_RESULTS,
  DEFAULT_LIST_CONTAINERS_MAX_RESULTS
} from "../utils/constants";
import BlobReferredExtentsAsyncIterator from "./BlobReferredExtentsAsyncIterator";
import IBlobMetadataStore, {
  AcquireBlobLeaseResponse,
  AcquireContainerLeaseResponse,
  BlobId,
  BlobModel,
  BlobPrefixModel,
  BlockModel,
  BreakBlobLeaseResponse,
  BreakContainerLeaseResponse,
  ChangeBlobLeaseResponse,
  ChangeContainerLeaseResponse,
  ContainerModel,
  CreateSnapshotResponse,
  FilterBlobModel,
  GetBlobPropertiesRes,
  GetContainerAccessPolicyResponse,
  GetContainerPropertiesResponse,
  GetPageRangeResponse,
  IContainerMetadata,
  IExtentChunk,
  PersistencyBlockModel,
  ReleaseBlobLeaseResponse,
  RenewBlobLeaseResponse,
  RenewContainerLeaseResponse,
  ServicePropertiesModel,
  SetContainerAccessPolicyOptions
} from "./IBlobMetadataStore";
import PageWithDelimiter from "./PageWithDelimiter";
import FilterBlobPage from "./FilterBlobPage";
import { getBlobTagsCount, getTagsFromString, toBlobTags } from "../utils/utils";
import { generateQueryBlobWithTagsWhereFunction } from "./QueryInterpreter/QueryInterpreter";
import { NotImplementedinSQLError } from "../errors/NotImplementedError";

// tslint:disable: max-classes-per-file
class ServicesModel extends Model { }
class ContainersModel extends Model { }
class BlobsModel extends Model { }
class BlocksModel extends Model { }
// class PagesModel extends Model {}

interface IBlobContentProperties {
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentMD5?: Uint8Array;
  contentDisposition?: string;
  cacheControl?: string;
}

/**
 * A SQL based Blob metadata storage implementation based on Sequelize.
 * Refer to CONTRIBUTION.md for how to setup SQL database environment.
 *
 * @export
 * @class SqlBlobMetadataStore
 * @implements {IBlobMetadataStore}
 */
export default class SqlBlobMetadataStore implements IBlobMetadataStore {
  private initialized: boolean = false;
  private closed: boolean = false;
  private readonly sequelize: Sequelize;

  /**
   * Creates an instance of SqlBlobMetadataStore.
   *
   * @param {string} connectionURI For example, "postgres://user:pass@example.com:5432/dbname"
   * @param {SequelizeOptions} [sequelizeOptions]
   * @memberof SqlBlobMetadataStore
   */
  public constructor(
    connectionURI: string,
    sequelizeOptions?: SequelizeOptions
  ) {
    // Enable encrypt connection for SQL Server
    if (connectionURI.startsWith("mssql") && sequelizeOptions) {
      sequelizeOptions.dialectOptions = sequelizeOptions.dialectOptions || {};
      (sequelizeOptions.dialectOptions as any).options =
        (sequelizeOptions.dialectOptions as any).options || {};
      (sequelizeOptions.dialectOptions as any).options.encrypt = true;
    }
    this.sequelize = new Sequelize(connectionURI, sequelizeOptions);
  }

  public async init(): Promise<void> {
    await this.sequelize.authenticate();

    ServicesModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          primaryKey: true
        },
        defaultServiceVersion: {
          type: "VARCHAR(10)"
        },
        cors: {
          type: "VARCHAR(4095)"
        },
        logging: {
          type: "VARCHAR(255)"
        },
        minuteMetrics: {
          type: "VARCHAR(255)"
        },
        hourMetrics: {
          type: "VARCHAR(255)"
        },
        staticWebsite: {
          type: "VARCHAR(1023)"
        },
        deleteRetentionPolicy: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Services",
        tableName: "Services",
        timestamps: false
      }
    );

    ContainersModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          unique: "accountname_containername"
        },
        // tslint:disable-next-line:max-line-length
        // https://docs.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata
        containerName: {
          type: "VARCHAR(63)",
          unique: "accountname_containername"
        },
        containerId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        lastModified: {
          allowNull: false,
          type: DATE(6)
        },
        etag: {
          allowNull: false,
          type: "VARCHAR(127)"
        },
        // TODO: Confirm max length of metadata pairs
        metadata: {
          type: "VARCHAR(4095)"
        },
        containerAcl: {
          type: "VARCHAR(1023)"
        },
        publicAccess: {
          type: "VARCHAR(31)"
        },
        lease: {
          type: "VARCHAR(1023)"
        },
        hasImmutabilityPolicy: {
          type: BOOLEAN
        },
        hasLegalHold: {
          type: BOOLEAN
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Containers",
        tableName: "Containers",
        charset: DEFAULT_SQL_CHARSET,
        collate: DEFAULT_SQL_COLLATE,
        timestamps: false
      }
    );

    BlobsModel.init(
      {
        accountName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        containerName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        blobName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        snapshot: {
          type: "VARCHAR(64)",
          allowNull: false,
          defaultValue: ""
        },
        blobId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        lastModified: {
          allowNull: false,
          type: DATE(6)
        },
        creationTime: {
          allowNull: false,
          type: DATE(6)
        },
        accessTierChangeTime: {
          allowNull: true,
          type: DATE(6)
        },
        accessTierInferred: {
          type: BOOLEAN
        },
        etag: {
          allowNull: false,
          type: "VARCHAR(127)"
        },
        blobType: {
          allowNull: false,
          type: "VARCHAR(31)"
        },
        blobSequenceNumber: {
          type: "VARCHAR(63)"
        },
        accessTier: {
          type: "VARCHAR(31)"
        },
        contentProperties: {
          type: "VARCHAR(1023)"
        },
        lease: {
          type: "VARCHAR(1023)"
        },
        deleting: {
          type: INTEGER.UNSIGNED,
          defaultValue: 0, // 0 means container is not under deleting(gc)
          allowNull: false
        },
        isCommitted: {
          type: BOOLEAN,
          allowNull: false
        },
        persistency: {
          type: "VARCHAR(255)"
        },
        committedBlocksInOrder: {
          type: TEXT({ length: "medium" })
        },
        metadata: {
          type: "VARCHAR(2047)"
        },
        blobTags: {
          type: "VARCHAR(4096)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Blobs",
        tableName: "Blobs",
        timestamps: false,
        charset: DEFAULT_SQL_CHARSET,
        collate: DEFAULT_SQL_COLLATE,
        indexes: [
          {
            // name: 'title_index',
            // using: 'BTREE',
            unique: true,
            fields: [
              "accountName",
              "containerName",
              "blobName",
              "snapshot",
              "deleting"
            ]
          }
        ]
      }
    );

    BlocksModel.init(
      {
        accountName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        containerName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        blobName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        // TODO: Check max block name length
        blockName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        deleting: {
          type: INTEGER.UNSIGNED,
          defaultValue: 0, // 0 means container is not under deleting(gc)
          allowNull: false
        },
        size: {
          type: INTEGER.UNSIGNED,
          allowNull: false
        },
        persistency: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Blocks",
        tableName: "Blocks",
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: ["accountName", "containerName", "blobName", "blockName"]
          }
        ]
      }
    );

    // TODO: sync() is only for development purpose, use migration for production
    await this.sequelize.sync();

    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async close(): Promise<void> {
    await this.sequelize.close();
    this.closed = true;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public async clean(): Promise<void> {
    // TODO: Implement cleanup in database
  }

  public async setServiceProperties(
    context: Context,
    serviceProperties: ServicePropertiesModel
  ): Promise<ServicePropertiesModel> {
    return this.sequelize.transaction(async (t) => {
      const findResult = await ServicesModel.findByPk(
        serviceProperties.accountName,
        {
          transaction: t
        }
      );
      const updateValues = {
        defaultServiceVersion: serviceProperties.defaultServiceVersion,
        cors: this.serializeModelValue(serviceProperties.cors),
        logging: this.serializeModelValue(serviceProperties.logging),
        minuteMetrics: this.serializeModelValue(
          serviceProperties.minuteMetrics
        ),
        hourMetrics: this.serializeModelValue(serviceProperties.hourMetrics),
        staticWebsite: this.serializeModelValue(
          serviceProperties.staticWebsite
        ),
        deleteRetentionPolicy: this.serializeModelValue(
          serviceProperties.deleteRetentionPolicy
        )
      };
      if (findResult === null) {
        await ServicesModel.create(
          {
            accountName: serviceProperties.accountName,
            ...updateValues
          },
          { transaction: t }
        );
      } else {
        const updateResult = await ServicesModel.update(updateValues, {
          transaction: t,
          where: {
            accountName: serviceProperties.accountName
          }
        });

        // Set the exactly equal properties will affect 0 rows.
        const updatedRows = updateResult[0];
        if (updatedRows > 1) {
          throw Error(
            `SqlBlobMetadataStore:updateServiceProperties() failed. Update operation affect ${updatedRows} rows.`
          );
        }
      }

      return serviceProperties;
    });
  }

  public async getServiceProperties(
    context: Context,
    account: string
  ): Promise<ServicePropertiesModel | undefined> {
    const findResult = await ServicesModel.findByPk(account);
    if (findResult === null) {
      return undefined;
    }

    const logging = this.deserializeModelValue(findResult, "logging");
    const hourMetrics = this.deserializeModelValue(findResult, "hourMetrics");
    const minuteMetrics = this.deserializeModelValue(
      findResult,
      "minuteMetrics"
    );
    const cors = this.deserializeModelValue(findResult, "cors");
    const deleteRetentionPolicy = this.deserializeModelValue(
      findResult,
      "deleteRetentionPolicy"
    );
    const staticWebsite = this.deserializeModelValue(
      findResult,
      "staticWebsite"
    );
    const defaultServiceVersion = this.getModelValue<string>(
      findResult,
      "defaultServiceVersion"
    );

    const ret: ServicePropertiesModel = {
      accountName: account
    };

    if (logging !== undefined) {
      ret.logging = logging;
    }
    if (hourMetrics !== undefined) {
      ret.hourMetrics = hourMetrics;
    }
    if (minuteMetrics !== undefined) {
      ret.minuteMetrics = minuteMetrics;
    }
    if (cors !== undefined) {
      ret.cors = cors;
    }
    if (deleteRetentionPolicy !== undefined) {
      ret.deleteRetentionPolicy = deleteRetentionPolicy;
    }
    if (staticWebsite !== undefined) {
      ret.staticWebsite = staticWebsite;
    }
    if (defaultServiceVersion !== undefined) {
      ret.defaultServiceVersion = defaultServiceVersion;
    }

    return ret;
  }

  public async listContainers(
    context: Context,
    account: string,
    prefix: string = "",
    maxResults: number = DEFAULT_LIST_CONTAINERS_MAX_RESULTS,
    marker: string
  ): Promise<[ContainerModel[], string | undefined]> {
    const whereQuery: any = { accountName: account };

    if (prefix.length > 0) {
      whereQuery.containerName = {
        [Op.like]: `${prefix}%`
      };
    }

    if (marker !== "") {
      if (whereQuery.containerName === undefined) {
        whereQuery.containerName = {
          [Op.gt]: marker
        };
      } else {
        whereQuery.containerName[Op.gt] = marker;
      }
    }

    const findResult = await ContainersModel.findAll({
      limit: maxResults + 1,
      where: whereQuery as any,
      order: [["containerName", "ASC"]]
    });

    const leaseUpdateMapper = (model: ContainersModel) => {
      const containerModel = this.convertDbModelToContainerModel(model);
      return LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      ).sync(new ContainerLeaseSyncer(containerModel));
    };

    if (findResult.length <= maxResults) {
      return [findResult.map(leaseUpdateMapper), undefined];
    } else {
      const tail = findResult[findResult.length - 2];
      findResult.pop();
      const nextMarker = this.getModelValue<string>(
        tail,
        "containerName",
        true
      );
      return [findResult.map(leaseUpdateMapper), nextMarker];
    }
  }

  public async createContainer(
    context: Context,
    container: ContainerModel
  ): Promise<ContainerModel> {
    try {
      await ContainersModel.create(
        this.convertContainerModelToDbModel(container)
      );
      return container;
    } catch (err) {
      if (err.name === "SequelizeUniqueConstraintError") {
        throw StorageErrorFactory.getContainerAlreadyExists(context.contextId);
      }
      throw err;
    }
  }

  public async getContainerProperties(
    context: Context,
    account: string,
    container: string,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<GetContainerPropertiesResponse> {
    const findResult = await this.assertContainerExists(
      context,
      account,
      container,
      undefined,
      true
    );
    const containerModel = this.convertDbModelToContainerModel(findResult);

    return LeaseFactory.createLeaseState(
      new ContainerLeaseAdapter(containerModel),
      context
    )
      .validate(new ContainerReadLeaseValidator(leaseAccessConditions))
      .sync(new ContainerLeaseSyncer(containerModel));
  }

  public async deleteContainer(
    context: Context,
    account: string,
    container: string,
    options: Models.ContainerDeleteMethodOptionalParams = {}
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        attributes: [
          "accountName",
          "containerName",
          "etag",
          "lastModified",
          "lease"
        ],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      LeaseFactory.createLeaseState(
        this.convertDbModelToLease(findResult),
        context
      ).validate(
        new ContainerDeleteLeaseValidator(options.leaseAccessConditions)
      );

      await ContainersModel.destroy({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      await this.deleteBlobFromSQL({
          accountName: account,
          containerName: container
        },
        t
      );

      await this.deleteBlockFromSQL({
          accountName: account,
          containerName: container
        },
        t
      );
    });
  }

  public async setContainerMetadata(
    context: Context,
    account: string,
    container: string,
    lastModified: Date,
    etag: string,
    metadata?: IContainerMetadata,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<void> {
    return this.sequelize.transaction(async (t) => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        attributes: [
          "accountName",
          "containerName",
          "etag",
          "lastModified",
          "lease"
        ],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      LeaseFactory.createLeaseState(
        this.convertDbModelToLease(findResult),
        context
      ).validate(new ContainerReadLeaseValidator(leaseAccessConditions));

      await ContainersModel.update(
        {
          lastModified,
          etag,
          metadata: this.serializeModelValue(metadata) || null
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );
      /* Transaction ends */
    });
  }

  public async getContainerACL(
    context: Context,
    account: string,
    container: string,
    leaseAccessConditions?: Models.LeaseAccessConditions | undefined
  ): Promise<GetContainerAccessPolicyResponse> {
    const findResult = await ContainersModel.findOne({
      where: {
        accountName: account,
        containerName: container
      }
    });

    if (findResult === null || findResult === undefined) {
      throw StorageErrorFactory.getContainerNotFound(context.contextId);
    }

    const containerModel = this.convertDbModelToContainerModel(findResult);

    LeaseFactory.createLeaseState(
      new ContainerLeaseAdapter(containerModel),
      context
    )
      .validate(new ContainerReadLeaseValidator(leaseAccessConditions))
      .sync(new ContainerLeaseSyncer(containerModel));

    return {
      properties: containerModel.properties,
      containerAcl: containerModel.containerAcl
    };
  }

  public async setContainerACL(
    context: Context,
    account: string,
    container: string,
    setAclModel: SetContainerAccessPolicyOptions
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      const findResult = await ContainersModel.findOne({
        attributes: [
          "accountName",
          "containerName",
          "etag",
          "lastModified",
          "lease"
        ],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        setAclModel.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const lease = this.convertDbModelToLease(findResult);

      LeaseFactory.createLeaseState(lease, context).validate(
        new ContainerReadLeaseValidator(setAclModel.leaseAccessConditions)
      );

      const updateResult = await ContainersModel.update(
        {
          lastModified: setAclModel.lastModified,
          etag: setAclModel.etag,
          containerAcl:
            this.serializeModelValue(setAclModel.containerAcl) || null,
          publicAccess: this.serializeModelValue(setAclModel.publicAccess)
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      if (updateResult[0] === 0) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }
    });
  }

  public async acquireContainerLease(
    context: Context,
    account: string,
    container: string,
    options: Models.ContainerAcquireLeaseOptionalParams
  ): Promise<AcquireContainerLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);
      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .acquire(options.duration!, options.proposedLeaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
      /* Transaction ends */
    });
  }

  public async releaseContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string,
    options: Models.ContainerReleaseLeaseOptionalParams = {}
  ): Promise<Models.ContainerProperties> {
    return this.sequelize.transaction(async (t) => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .release(leaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return containerModel.properties;
      /* Transaction ends */
    });
  }

  public async renewContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string,
    options: Models.ContainerRenewLeaseOptionalParams = {}
  ): Promise<RenewContainerLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      /* Transaction starts */
      // TODO: Filter out unnecessary fields in select query
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .renew(leaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
      /* Transaction ends */
    });
  }

  public async breakContainerLease(
    context: Context,
    account: string,
    container: string,
    breakPeriod: number | undefined,
    options: Models.ContainerBreakLeaseOptionalParams = {}
  ): Promise<BreakContainerLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .break(breakPeriod)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      const leaseTimeSeconds: number =
        containerModel.properties.leaseState ===
          Models.LeaseStateType.Breaking && containerModel.leaseBreakTime
          ? Math.round(
            (containerModel.leaseBreakTime.getTime() -
              context.startTime!.getTime()) /
            1000
          )
          : 0;

      return {
        properties: containerModel.properties,
        leaseTime: leaseTimeSeconds
      };
    });
  }

  public async changeContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string,
    proposedLeaseId: string,
    options: Models.ContainerChangeLeaseOptionalParams = {}
  ): Promise<ChangeContainerLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        findResult ? this.convertDbModelToContainerModel(findResult) : undefined
      );

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .change(leaseId, proposedLeaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
    });
  }

  public async checkContainerExist(
    context: Context,
    account: string,
    container: string
  ): Promise<void> {
    await this.assertContainerExists(context, account, container, undefined);
  }

  public async createBlob(
    context: Context,
    blob: BlobModel,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<void> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(
        context,
        blob.accountName,
        blob.containerName,
        t
      );

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          snapshot: blob.snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult)
          : undefined
      );

      // Create if not exists
      if (
        modifiedAccessConditions &&
        modifiedAccessConditions.ifNoneMatch === "*" &&
        blobFindResult
      ) {
        throw StorageErrorFactory.getBlobAlreadyExists(context.contextId);
      }

      if (blobFindResult) {
        const blobModel: BlobModel = this.convertDbModelToBlobModel(
          blobFindResult
        );

        LeaseFactory.createLeaseState(new BlobLeaseAdapter(blobModel), context)
          .validate(new BlobWriteLeaseValidator(leaseAccessConditions))
          .sync(new BlobWriteLeaseSyncer(blob)); // Keep original blob lease;

        if (
          blobModel.properties !== undefined &&
          blobModel.properties.accessTier === Models.AccessTier.Archive
        ) {
          throw StorageErrorFactory.getBlobArchived(context.contextId);
        }
      }

      await BlobsModel.upsert(this.convertBlobModelToDbModel(blob), {
        transaction: t
      });
    });
  }

  public async downloadBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<BlobModel> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateReadConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult)
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      return LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      )
        .validate(new BlobReadLeaseValidator(leaseAccessConditions))
        .sync(new BlobLeaseSyncer(blobModel));
    });
  }

  public async filterBlobs(
    context: Context,
    account: string,
    container?: string,
    where?: string,
    maxResults: number = DEFAULT_LIST_BLOBS_MAX_RESULTS,
    marker?: string,
  ): Promise<[FilterBlobModel[], string | undefined]> {
    return this.sequelize.transaction(async (t) => {
      if (container) {
        await this.assertContainerExists(context, account, container, t);
      }

      let whereQuery: any;
      if (container) {
        whereQuery = {
          accountName: account,
          containerName: container
        }
      }
      else {
        whereQuery = {
          accountName: account
        };
      };

      if (marker !== undefined) {
        if (whereQuery.blobName !== undefined) {
          whereQuery.blobName[Op.gt] = marker;
        } else {
          whereQuery.blobName = {
            [Op.gt]: marker
          };
        }
      }
      whereQuery.snapshot = "";
      whereQuery.deleting = 0;

      // fill the page by possibly querying multiple times
      const page = new FilterBlobPage<BlobsModel>(maxResults);

      const nameItem = (item: BlobsModel): string => {
        return this.getModelValue<string>(item, "blobName", true);
      };
      const filterFunction = generateQueryBlobWithTagsWhereFunction(context, where!);

      const readPage = async (off: number): Promise<BlobsModel[]> => {
        return (await BlobsModel.findAll({
          where: whereQuery as any,
          order: [["blobName", "ASC"]],
          transaction: t,
          limit: maxResults,
          offset: off
        }));
      };

      const [blobItems, nextMarker] = await page.fill(readPage, nameItem);

      const filterBlobModelMapper = (model: BlobsModel) => {
        return this.convertDbModelToFilterBlobModel(model);
      };

      return [blobItems.map(filterBlobModelMapper).filter((blobItem) => {
        const tagsMeetConditions = filterFunction(blobItem);
        if (tagsMeetConditions.length !== 0) {
          blobItem.tags = { blobTagSet: toBlobTags(tagsMeetConditions) };
          return true;
        }
        return false;
      }), nextMarker];
    });
  }

  public async listBlobs(
    context: Context,
    account: string,
    container: string,
    delimiter?: string,
    blob?: string,
    prefix: string = "",
    maxResults: number = DEFAULT_LIST_BLOBS_MAX_RESULTS,
    marker?: string,
    includeSnapshots?: boolean,
    includeUncommittedBlobs?: boolean
  ): Promise<[BlobModel[], BlobPrefixModel[], any | undefined]> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const whereQuery: any = {
        accountName: account,
        containerName: container
      };

      if (blob !== undefined) {
        whereQuery.blobName = blob;
      } else {
        if (prefix.length > 0) {
          whereQuery.blobName = {
            [Op.like]: `${prefix}%`
          };
        }

        if (marker !== undefined) {
          if (whereQuery.blobName !== undefined) {
            whereQuery.blobName[Op.gt] = marker;
          } else {
            whereQuery.blobName = {
              [Op.gt]: marker
            };
          }
        }
      }
      if (!includeSnapshots) {
        whereQuery.snapshot = "";
      }
      if (!includeUncommittedBlobs) {
        whereQuery.isCommitted = true;
      }
      whereQuery.deleting = 0;

      const leaseUpdateMapper = (model: BlobsModel) => {
        const blobModel = this.convertDbModelToBlobModel(model);
        return LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).sync(new BlobLeaseSyncer(blobModel));
      };

      // fill the page by possibly querying multiple times
      const page = new PageWithDelimiter<BlobsModel>(maxResults, delimiter, prefix);

      const nameItem = (item: BlobsModel): string => {
        return this.getModelValue<string>(item, "blobName", true);
      };

      const readPage = async (off: number): Promise<BlobsModel[]> => {
        return await BlobsModel.findAll({
          where: whereQuery as any,
          order: [["blobName", "ASC"]],
          transaction: t,
          limit: maxResults,
          offset: off
        });
      };

      const [blobItems, blobPrefixes, nextMarker] = await page.fill(readPage, nameItem);

      return [blobItems.map(leaseUpdateMapper), blobPrefixes, nextMarker];
    });
  }

  public async listAllBlobs(
    maxResults: number = DEFAULT_LIST_BLOBS_MAX_RESULTS,
    marker?: string,
    includeSnapshots?: boolean,
    includeUncommittedBlobs?: boolean
  ): Promise<[BlobModel[], any | undefined]> {
    const whereQuery: any = {};
    if (marker !== undefined) {
      whereQuery.blobName = {
        [Op.gt]: marker
      };
    }
    if (!includeSnapshots) {
      whereQuery.snapshot = "";
    }
    if (!includeUncommittedBlobs) {
      whereQuery.isCommitted = true;
    }
    whereQuery.deleting = 0;

    const blobFindResult = await BlobsModel.findAll({
      limit: maxResults + 1,
      where: whereQuery as any,
      order: [["blobName", "ASC"]]
    });

    if (blobFindResult.length <= maxResults) {
      return [
        blobFindResult.map(this.convertDbModelToBlobModel.bind(this)),
        undefined
      ];
    } else {
      blobFindResult.pop();
      const tail = blobFindResult[blobFindResult.length - 1];
      const nextMarker = this.getModelValue<string>(tail, "blobName", true);
      return [
        blobFindResult.map(this.convertDbModelToBlobModel.bind(this)),
        nextMarker
      ];
    }
  }

  public async stageBlock(
    context: Context,
    block: BlockModel,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(
        context,
        block.accountName,
        block.containerName,
        t
      );

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: block.accountName,
          containerName: block.containerName,
          blobName: block.blobName,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (blobFindResult !== null && blobFindResult !== undefined) {
        const blobModel: BlobModel = this.convertDbModelToBlobModel(
          blobFindResult
        );

        if (blobModel.isCommitted === true) {
          LeaseFactory.createLeaseState(
            new BlobLeaseAdapter(blobModel),
            context
          ).validate(new BlobWriteLeaseValidator(leaseAccessConditions));
        }

        // If the new block ID does not have same length with before uncommitted block ID, return failure.
        const existBlock = await BlocksModel.findOne({
          attributes: ["blockName"],
          where: {
            accountName: block.accountName,
            containerName: block.containerName,
            blobName: block.blobName,
            deleting: 0
          },
          order: [["id", "ASC"]],
          transaction: t
        });
        if (
          existBlock &&
          Buffer.from(
            this.getModelValue<string>(existBlock, "blockName", true),
            "base64"
          ).length !== Buffer.from(block.name, "base64").length
        ) {
          throw StorageErrorFactory.getInvalidBlobOrBlock(context.contextId);
        }
      } else {
        const newBlob = {
          deleted: false,
          accountName: block.accountName,
          containerName: block.containerName,
          name: block.blobName,
          properties: {
            creationTime: context.startTime!,
            lastModified: context.startTime!,
            etag: newEtag(),
            contentLength: 0,
            blobType: Models.BlobType.BlockBlob
          },
          snapshot: "",
          isCommitted: false
        };
        await BlobsModel.upsert(this.convertBlobModelToDbModel(newBlob), {
          transaction: t
        });
      }

      await BlocksModel.upsert(
        {
          accountName: block.accountName,
          containerName: block.containerName,
          blobName: block.blobName,
          blockName: block.name,
          size: block.size,
          deleting: 0,
          persistency: this.serializeModelValue(block.persistency)
        },
        { transaction: t }
      );
    });
  }

  public getBlockList(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    isCommitted?: boolean,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<any> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0
        },
        transaction: t
      });

      validateReadConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult)
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);
      LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).validate(new BlobReadLeaseValidator(leaseAccessConditions));

      const res: {
        uncommittedBlocks: Models.Block[];
        committedBlocks: Models.Block[];
      } = {
        uncommittedBlocks: [],
        committedBlocks: []
      };

      if (isCommitted !== false) {
        res.committedBlocks = blobModel.committedBlocksInOrder || [];
      }

      if (isCommitted !== true) {
        const blocks = await BlocksModel.findAll({
          attributes: ["blockName", "size"],
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            deleting: 0
          },
          order: [["id", "ASC"]],
          transaction: t
        });
        for (const item of blocks) {
          const block = {
            name: this.getModelValue<string>(item, "blockName", true),
            size: this.getModelValue<number>(item, "size", true)
          };
          res.uncommittedBlocks.push(block);
        }
      }
      return res;
    });
  }

  public async commitBlockList(
    context: Context,
    blob: BlobModel,
    blockList: { blockName: string; blockCommitType: string }[],
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(
        context,
        blob.accountName,
        blob.containerName,
        t
      );

      const pCommittedBlocksMap: Map<string, PersistencyBlockModel> = new Map(); // persistencyCommittedBlocksMap
      const pUncommittedBlocksMap: Map<
        string,
        PersistencyBlockModel
      > = new Map(); // persistencyUncommittedBlocksMap

      const badRequestError = StorageErrorFactory.getInvalidBlockList(
        context.contextId
      );

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          snapshot: blob.snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce duplicated convert
          : undefined
      );

      let creationTime = blob.properties.creationTime || context.startTime;

      if (blobFindResult !== null && blobFindResult !== undefined) {
        const blobModel: BlobModel = this.convertDbModelToBlobModel(
          blobFindResult
        );

        // Create if not exists
        if (
          modifiedAccessConditions &&
          modifiedAccessConditions.ifNoneMatch === "*" &&
          blobModel &&
          blobModel.isCommitted
        ) {
          throw StorageErrorFactory.getBlobAlreadyExists(context.contextId);
        }

        creationTime = blobModel.properties.creationTime || creationTime;

        LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).validate(new BlobWriteLeaseValidator(leaseAccessConditions));

        const committedBlocksInOrder = blobModel.committedBlocksInOrder;
        for (const pBlock of committedBlocksInOrder || []) {
          pCommittedBlocksMap.set(pBlock.name, pBlock);
        }
      }

      const blockFindResult = await BlocksModel.findAll({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          deleting: 0
        },
        transaction: t
      });
      for (const item of blockFindResult) {
        const block = {
          name: this.getModelValue<string>(item, "blockName", true),
          size: this.getModelValue<number>(item, "size", true),
          persistency: this.deserializeModelValue(item, "persistency")
        };
        pUncommittedBlocksMap.set(block.name, block);
      }
      const selectedBlockList: PersistencyBlockModel[] = [];
      for (const block of blockList) {
        switch (block.blockCommitType.toLowerCase()) {
          case "uncommitted":
            const pUncommittedBlock = pUncommittedBlocksMap.get(
              block.blockName
            );
            if (pUncommittedBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pUncommittedBlock);
            }
            break;
          case "committed":
            const pCommittedBlock = pCommittedBlocksMap.get(block.blockName);
            if (pCommittedBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pCommittedBlock);
            }
            break;
          case "latest":
            const pLatestBlock =
              pUncommittedBlocksMap.get(block.blockName) ||
              pCommittedBlocksMap.get(block.blockName);
            if (pLatestBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pLatestBlock);
            }
            break;
          default:
            throw badRequestError;
        }
      }

      const commitBlockBlob: BlobModel = {
        ...blob,
        deleted: false,
        committedBlocksInOrder: selectedBlockList,
        properties: {
          ...blob.properties,
          creationTime,
          lastModified: blob.properties.lastModified || context.startTime,
          contentLength: selectedBlockList
            .map((block) => block.size)
            .reduce((total, val) => {
              return total + val;
            }, 0),
          blobType: Models.BlobType.BlockBlob
        }
      };

      new BlobLeaseSyncer(commitBlockBlob).sync({
        leaseId: undefined,
        leaseExpireTime: undefined,
        leaseDurationSeconds: undefined,
        leaseBreakTime: undefined,
        leaseDurationType: undefined,
        leaseState: undefined,
        leaseStatus: undefined
      });

      await BlobsModel.upsert(this.convertBlobModelToDbModel(commitBlockBlob), {
        transaction: t
      });

      await BlocksModel.update(
        {
          deleting: literal("deleting + 1")
        },
        {
          where: {
            accountName: blob.accountName,
            containerName: blob.containerName,
            blobName: blob.name
          },
          transaction: t
        }
      );
    });
  }

  public async getBlobProperties(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<GetBlobPropertiesRes> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateReadConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult)
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      if (!blobModel.isCommitted) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      // TODO: Return blobCommittedBlockCount for append blob

      let responds = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      )
        .validate(new BlobReadLeaseValidator(leaseAccessConditions))
        .sync(new BlobLeaseSyncer(blobModel));
      return {
        ...responds,
        properties: {
          ...responds.properties,
          tagCount: getBlobTagsCount(blobModel.blobTags),
        },
      }
    });
  }

  public undeleteBlob(): Promise<void> {
    throw new NotImplementedinSQLError();
  }

  public async createSnapshot(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    metadata?: Models.BlobMetadata,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<CreateSnapshotResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateReadConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const snapshotBlob: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(snapshotBlob),
        context
      ).validate(new BlobReadLeaseValidator(leaseAccessConditions));

      const snapshotTime = convertDateTimeStringMsTo7Digital(
        context.startTime!.toISOString()
      );

      snapshotBlob.snapshot = snapshotTime;
      snapshotBlob.metadata = metadata || snapshotBlob.metadata;
      snapshotBlob.blobTags = snapshotBlob.blobTags;

      new BlobLeaseSyncer(snapshotBlob).sync({
        leaseId: undefined,
        leaseExpireTime: undefined,
        leaseDurationSeconds: undefined,
        leaseBreakTime: undefined,
        leaseDurationType: undefined,
        leaseState: undefined,
        leaseStatus: undefined
      });

      await BlobsModel.upsert(this.convertBlobModelToDbModel(snapshotBlob), {
        transaction: t
      });

      return {
        properties: snapshotBlob.properties,
        snapshot: snapshotTime
      };
    });
  }

  public async deleteBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    options: Models.BlobDeleteMethodOptionalParams
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: options.snapshot === undefined ? "" : options.snapshot,
          deleting: 0,
          isCommitted: true // TODO: Support deleting uncommitted block blob
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const againstBaseBlob = blobModel.snapshot === "";

      if (againstBaseBlob) {
        LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).validate(new BlobWriteLeaseValidator(options.leaseAccessConditions));
      }

      // Check bad requests
      if (!againstBaseBlob && options.deleteSnapshots !== undefined) {
        throw StorageErrorFactory.getInvalidOperation(
          context.contextId,
          "Invalid operation against a blob snapshot."
        );
      }

      // Scenario: Delete base blob only
      if (againstBaseBlob && options.deleteSnapshots === undefined) {
        const count = await BlobsModel.count({
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            deleting: 0
          },
          transaction: t
        });

        if (count > 1) {
          throw StorageErrorFactory.getSnapshotsPresent(context.contextId!);
        } else {
          await this.deleteBlobFromSQL({
              accountName: account,
              containerName: container,
              blobName: blob
            },
            t
          );

          await this.deleteBlockFromSQL({
              accountName: account,
              containerName: container,
              blobName: blob
            },
            t
          );
        }
      }

      // Scenario: Delete one snapshot only
      if (!againstBaseBlob) {
        await this.deleteBlobFromSQL({
              accountName: account,
              containerName: container,
              blobName: blob,
              snapshot: blobModel.snapshot
            },
            t
        );
      }

      // Scenario: Delete base blob and snapshots
      if (
        againstBaseBlob &&
        options.deleteSnapshots === Models.DeleteSnapshotsOptionType.Include
      ) {
        await this.deleteBlobFromSQL({
            accountName: account,
            containerName: container,
            blobName: blob
          },
          t
        );

        await this.deleteBlockFromSQL({
            accountName: account,
            containerName: container,
            blobName: blob
          },t
        );
      }

      // Scenario: Delete all snapshots only
      if (
        againstBaseBlob &&
        options.deleteSnapshots === Models.DeleteSnapshotsOptionType.Only
      ) {
        await this.deleteBlobFromSQL({
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: { [Op.gt]: "" }
          },
          t
        );
      }
    });
  }

  public async setBlobHTTPHeaders(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions: Models.LeaseAccessConditions | undefined,
    blobHTTPHeaders: Models.BlobHTTPHeaders | undefined,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobPropertiesInternal> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      LeaseFactory.createLeaseState(new BlobLeaseAdapter(blobModel), context)
        .validate(new BlobWriteLeaseValidator(leaseAccessConditions))
        .sync(new BlobWriteLeaseSyncer(blobModel));

      if (blobHTTPHeaders !== undefined) {
        blobModel.properties.cacheControl = blobHTTPHeaders.blobCacheControl;
        blobModel.properties.contentType = blobHTTPHeaders.blobContentType;
        blobModel.properties.contentMD5 = blobHTTPHeaders.blobContentMD5;
        blobModel.properties.contentEncoding =
          blobHTTPHeaders.blobContentEncoding;
        blobModel.properties.contentLanguage =
          blobHTTPHeaders.blobContentLanguage;
        blobModel.properties.contentDisposition =
          blobHTTPHeaders.blobContentDisposition;
      }

      blobModel.properties.etag = newEtag();
      blobModel.properties.lastModified = context.startTime
        ? context.startTime
        : new Date();

      await BlobsModel.update(this.convertBlobModelToDbModel(blobModel), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      return blobModel.properties;
    });
  }

  public setBlobMetadata(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions: Models.LeaseAccessConditions | undefined,
    metadata: Models.BlobMetadata | undefined,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobPropertiesInternal> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      LeaseFactory.createLeaseState(new BlobLeaseAdapter(blobModel), context)
        .validate(new BlobWriteLeaseValidator(leaseAccessConditions))
        .sync(new BlobWriteLeaseSyncer(blobModel));

      const lastModified = context.startTime! || new Date();
      const etag = newEtag();

      await BlobsModel.update(
        {
          metadata: this.serializeModelValue(metadata) || null,
          lastModified,
          etag,
          ...this.convertLeaseToDbModel(new BlobLeaseAdapter(blobModel))
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );

      const ret: Models.BlobPropertiesInternal = {
        lastModified,
        etag,
        leaseStatus: blobModel.properties.leaseStatus,
        leaseDuration: blobModel.properties.leaseDuration,
        leaseState: blobModel.properties.leaseState
      };

      return ret;
    });
  }

  public async acquireBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    duration: number,
    proposedLeaseId?: string,
    options: Models.BlobAcquireLeaseOptionalParams = {}
  ): Promise<AcquireBlobLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const lease = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).acquire(duration, proposedLeaseId).lease;

      await BlobsModel.update(this.convertLeaseToDbModel(lease), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });
      return { properties: blobModel.properties, leaseId: lease.leaseId };
    });
  }

  public async releaseBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string,
    options: Models.BlobReleaseLeaseOptionalParams = {}
  ): Promise<ReleaseBlobLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const lease = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).release(leaseId).lease;

      await BlobsModel.update(this.convertLeaseToDbModel(lease), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });
      return blobModel.properties;
    });
  }

  public async renewBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string,
    options: Models.BlobRenewLeaseOptionalParams = {}
  ): Promise<RenewBlobLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const lease = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).renew(leaseId).lease;

      await BlobsModel.update(this.convertLeaseToDbModel(lease), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });
      return { properties: blobModel.properties, leaseId: lease.leaseId };
    });
  }

  public async changeBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string,
    proposedLeaseId: string,
    options: Models.BlobChangeLeaseOptionalParams = {}
  ): Promise<ChangeBlobLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const lease = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).change(leaseId, proposedLeaseId).lease;

      await BlobsModel.update(this.convertLeaseToDbModel(lease), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });
      return { properties: blobModel.properties, leaseId: lease.leaseId };
    });
  }

  public async breakBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    breakPeriod: number | undefined,
    options: Models.BlobBreakLeaseOptionalParams = {}
  ): Promise<BreakBlobLeaseResponse> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        blobFindResult
          ? this.convertDbModelToBlobModel(blobFindResult) // TODO: Reduce double convert
          : undefined
      );

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      const lease = LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).break(breakPeriod).lease;

      const leaseTimeSeconds: number =
        lease.leaseState === Models.LeaseStateType.Breaking &&
          lease.leaseBreakTime
          ? Math.round(
            (lease.leaseBreakTime.getTime() - context.startTime!.getTime()) /
            1000
          )
          : 0;

      await BlobsModel.update(this.convertLeaseToDbModel(lease), {
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });
      return { properties: blobModel.properties, leaseTime: leaseTimeSeconds };
    });
  }

  public async checkBlobExist(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined
  ): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: snapshot ? snapshot : "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }
    });
  }

  public async getBlobType(
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined
  ): Promise<
    { blobType: Models.BlobType | undefined; isCommitted: boolean } | undefined
  > {
    const res = await BlobsModel.findOne({
      where: {
        accountName: account,
        containerName: container,
        blobName: blob,
        snapshot: snapshot ? snapshot : "",
        deleting: 0
      }
    });

    if (res === null || res === undefined) {
      return undefined;
    }

    const blobType = this.getModelValue<Models.BlobType>(res, "blobType", true);
    const isCommitted = this.getModelValue<boolean>(res, "isCommitted", true);

    return { blobType, isCommitted };
  }

  public startCopyFromURL(
    context: Context,
    source: BlobId,
    destination: BlobId,
    copySource: string,
    metadata: Models.BlobMetadata | undefined,
    tier: Models.AccessTier | undefined,
    options: Models.BlobStartCopyFromURLOptionalParams = {}
  ): Promise<Models.BlobPropertiesInternal> {
    return this.sequelize.transaction(async (t) => {
      const sourceBlob = await this.getBlobWithLeaseUpdated(
        source.account,
        source.container,
        source.blob,
        source.snapshot,
        context,
        true,
        true,
        t
      );

      options.sourceModifiedAccessConditions =
        options.sourceModifiedAccessConditions || {};
      validateReadConditions(
        context,
        {
          ifModifiedSince:
            options.sourceModifiedAccessConditions.sourceIfModifiedSince,
          ifUnmodifiedSince:
            options.sourceModifiedAccessConditions.sourceIfUnmodifiedSince,
          ifMatch: options.sourceModifiedAccessConditions.sourceIfMatch,
          ifNoneMatch: options.sourceModifiedAccessConditions.sourceIfNoneMatch,
          ifTags: options.sourceModifiedAccessConditions.sourceIfTags,
        },
        sourceBlob,
        true
      );

      const destBlob = await this.getBlobWithLeaseUpdated(
        destination.account,
        destination.container,
        destination.blob,
        undefined,
        context,
        false,
        undefined,
        t
      );

      validateWriteConditions(
        context,
        options.modifiedAccessConditions,
        destBlob
      );

      if (destBlob) {
        new BlobWriteLeaseValidator(options.leaseAccessConditions).validate(
          new BlobLeaseAdapter(destBlob),
          context
        );
      }

      // If source is uncommitted or deleted
      if (
        sourceBlob === undefined ||
        sourceBlob.deleted ||
        !sourceBlob.isCommitted
      ) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId!);
      }

      if (sourceBlob.properties.accessTier === Models.AccessTier.Archive
        && (tier === undefined || source.account !== destination.account)) {
        throw StorageErrorFactory.getBlobArchived(context.contextId!);
      }

      await this.assertContainerExists(
        context,
        destination.account,
        destination.container,
        t
      );

      // Deep clone a copied blob
      const copiedBlob: BlobModel = {
        name: destination.blob,
        deleted: false,
        snapshot: "",
        properties: {
          ...sourceBlob.properties,
          creationTime: context.startTime!,
          lastModified: context.startTime!,
          etag: newEtag(),
          leaseStatus:
            destBlob !== undefined
              ? destBlob.properties.leaseStatus
              : Models.LeaseStatusType.Unlocked,
          leaseState:
            destBlob !== undefined
              ? destBlob.properties.leaseState
              : Models.LeaseStateType.Available,
          leaseDuration:
            destBlob !== undefined
              ? destBlob.properties.leaseDuration
              : undefined,
          copyId: uuid(),
          copyStatus: Models.CopyStatusType.Success,
          copySource,
          copyProgress: sourceBlob.properties.contentLength
            ? `${sourceBlob.properties.contentLength}/${sourceBlob.properties.contentLength}`
            : undefined,
          copyCompletionTime: context.startTime,
          copyStatusDescription: undefined,
          incrementalCopy: false,
          destinationSnapshot: undefined,
          deletedTime: undefined,
          remainingRetentionDays: undefined,
          archiveStatus: undefined,
          accessTierChangeTime: undefined
        },
        metadata:
          metadata === undefined || Object.keys(metadata).length === 0
            ? { ...sourceBlob.metadata }
            : metadata,
        accountName: destination.account,
        containerName: destination.container,
        pageRangesInOrder: sourceBlob.pageRangesInOrder,
        isCommitted: sourceBlob.isCommitted,
        leaseDurationSeconds:
          destBlob !== undefined ? destBlob.leaseDurationSeconds : undefined,
        leaseId: destBlob !== undefined ? destBlob.leaseId : undefined,
        leaseExpireTime:
          destBlob !== undefined ? destBlob.leaseExpireTime : undefined,
        leaseBreakTime:
          destBlob !== undefined ? destBlob.leaseBreakTime : undefined,
        committedBlocksInOrder: sourceBlob.committedBlocksInOrder,
        persistency: sourceBlob.persistency,
        blobTags: options.blobTagsString === undefined ? undefined : getTagsFromString(options.blobTagsString, context.contextId!)
      };

      if (
        copiedBlob.properties.blobType === Models.BlobType.BlockBlob &&
        tier !== undefined
      ) {
        copiedBlob.properties.accessTier = this.parseTier(tier);
        if (copiedBlob.properties.accessTier === undefined) {
          throw StorageErrorFactory.getInvalidHeaderValue(context.contextId, {
            HeaderName: "x-ms-access-tier",
            HeaderValue: `${tier}`
          });
        }
      }

      if (
        copiedBlob.properties.blobType === Models.BlobType.PageBlob &&
        tier !== undefined
      ) {
        throw StorageErrorFactory.getInvalidHeaderValue(context.contextId, {
          HeaderName: "x-ms-access-tier",
          HeaderValue: `${tier}`
        });
      }

      await BlobsModel.upsert(this.convertBlobModelToDbModel(copiedBlob), {
        transaction: t
      });
      return copiedBlob.properties;
    });
  }

  public copyFromURL(
    context: Context,
    source: BlobId,
    destination: BlobId,
    copySource: string,
    metadata: Models.BlobMetadata | undefined
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public setTier(
    context: Context,
    account: string,
    container: string,
    blob: string,
    tier: Models.AccessTier,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<200 | 202> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      let responseCode: 200 | 202 = 200;

      // check the lease action aligned with current lease state.
      // the API has not lease ID input, but run it on a lease blocked blob will fail with LeaseIdMissing,
      // this is aligned with server behavior

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).validate(new BlobWriteLeaseValidator(leaseAccessConditions));

      // Check Blob is not snapshot
      const snapshot = blobModel.snapshot;
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId);
      }

      // Check BlobTier matches blob type
      let accessTier = blobModel.properties.accessTier;
      const blobType = blobModel.properties.blobType;
      if (
        (tier === Models.AccessTier.Archive ||
          tier === Models.AccessTier.Cool ||
          tier === Models.AccessTier.Hot ||
          tier === Models.AccessTier.Cold) &&
        blobType === Models.BlobType.BlockBlob
      ) {
        // Block blob
        // tslint:disable-next-line:max-line-length
        // TODO: check blob is not block blob with snapshot, throw StorageErrorFactory.getBlobSnapshotsPresent_hassnapshot()

        // Archive -> Coo/Hot will return 202
        if (
          accessTier === Models.AccessTier.Archive &&
          (tier === Models.AccessTier.Cool || tier === Models.AccessTier.Hot || tier === Models.AccessTier.Cold)
        ) {
          responseCode = 202;
        }

        accessTier = tier;
      } else {
        throw StorageErrorFactory.getAccessTierNotSupportedForBlobType(
          context.contextId!
        );
      }
      await BlobsModel.update(
        {
          accessTier,
          accessTierInferred: false,
          accessTierChangeTime: context.startTime
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );

      return responseCode;
    });
  }

  public uploadPages(
    context: Context,
    blob: BlobModel,
    start: number,
    end: number,
    persistency: IExtentChunk,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public clearRange(
    context: Context,
    blob: BlobModel,
    start: number,
    end: number,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public getPageRanges(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<GetPageRangeResponse> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public resizePageBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    blobContentLength: number,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public updateSequenceNumber(
    context: Context,
    account: string,
    container: string,
    blob: string,
    sequenceNumberAction: Models.SequenceNumberActionType,
    blobSequenceNumber: number | undefined
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public appendBlock(
    context: Context,
    block: BlockModel,
    leaseAccessConditions?: Models.LeaseAccessConditions | undefined,
    modifiedAccessConditions?: Models.ModifiedAccessConditions | undefined,
    appendPositionAccessConditions?:
      | Models.AppendPositionAccessConditions
      | undefined
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }

  public async listUncommittedBlockPersistencyChunks(
    marker: string = "-1",
    maxResults: number = 2000
  ): Promise<[IExtentChunk[], string | undefined]> {
    return BlocksModel.findAll({
      attributes: ["id", "persistency"],
      where: {
        id: {
          [Op.gt]: parseInt(marker, 10)
        },
        deleting: 0
      },
      limit: maxResults + 1,
      order: [["id", "ASC"]]
    }).then((res) => {
      if (res.length < maxResults) {
        return [
          res.map((obj) => {
            return this.deserializeModelValue(obj, "persistency", true);
          }),
          undefined
        ];
      } else {
        res.pop();
        const nextMarker = this.getModelValue<string>(
          res[res.length - 1],
          "id",
          true
        );
        return [
          res.map((obj) =>
            this.deserializeModelValue(obj, "persistency", true)
          ),
          nextMarker
        ];
      }
    });
  }

  public iteratorExtents(): AsyncIterator<string[]> {
    return new BlobReferredExtentsAsyncIterator(this);
  }

  private async assertContainerExists(
    context: Context,
    account: string,
    container: string,
    transaction?: Transaction,
    fullResult: boolean = false
  ): Promise<ContainersModel> {
    const findResult = await ContainersModel.findOne({
      attributes: fullResult ? undefined : ["accountName"],
      where: {
        accountName: account,
        containerName: container
      },
      transaction
    });
    if (findResult === undefined || findResult === null) {
      throw StorageErrorFactory.getContainerNotFound(context.contextId);
    }
    return findResult;
  }

  private getModelValue<T>(model: Model, key: string): T | undefined;
  private getModelValue<T>(model: Model, key: string, isRequired: true): T;
  private getModelValue<T>(
    model: Model,
    key: string,
    isRequired?: boolean
  ): T | undefined {
    let value = model.get(key) as T | undefined;
    if (value === null) {
      value = undefined;
    }
    if (value === undefined && isRequired === true) {
      // tslint:disable-next-line:max-line-length
      throw new Error(
        `SqlBlobMetadataStore:getModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }
    return value;
  }

  private deserializeModelValue(
    model: Model,
    key: string,
    isRequired: boolean = false
  ): any {
    const rawValue = this.getModelValue<string>(model, key);
    if (typeof rawValue === "string") {
      // TODO: Decouple deserializer
      return JSON.parse(rawValue);
    }

    if (isRequired) {
      throw new Error(
        // tslint:disable-next-line:max-line-length
        `SqlBlobMetadataStore:deserializeModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }

    return undefined;
  }

  private serializeModelValue(value: any): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return JSON.stringify(value);
  }

  /**
   * This method will restore object to Uint8Array.
   *
   * @private
   * @param {*} obj
   * @returns {(Uint8Array | undefined)}
   * @memberof LokiBlobMetadataStore
   */
  private restoreUint8Array(obj: any): Uint8Array | undefined {
    if (typeof obj !== "object") {
      return undefined;
    }

    if (obj instanceof Uint8Array) {
      return obj;
    }

    if (obj.type === "Buffer") {
      obj = obj.data;
    }

    const length = Object.keys(obj).length;
    const arr = Buffer.allocUnsafe(length);

    for (let i = 0; i < length; i++) {
      if (!obj.hasOwnProperty(i)) {
        throw new TypeError(
          `Cannot restore sql DB persisted object to Uint8Array. Key ${i} is missing.`
        );
      }

      arr[i] = obj[i];
    }

    return arr;
  }

  private convertDbModelToContainerModel(
    dbModel: ContainersModel
  ): ContainerModel {
    const accountName = this.getModelValue<string>(
      dbModel,
      "accountName",
      true
    );
    const name = this.getModelValue<string>(dbModel, "containerName", true);
    const containerAcl = this.deserializeModelValue(dbModel, "containerAcl");
    const metadata = this.deserializeModelValue(dbModel, "metadata");

    const lastModified = this.getModelValue<Date>(
      dbModel,
      "lastModified",
      true
    );
    const etag = this.getModelValue<string>(dbModel, "etag", true);
    const publicAccess = this.deserializeModelValue(dbModel, "publicAccess");
    const lease = this.convertDbModelToLease(dbModel);
    const leaseBreakTime = lease.leaseBreakTime;
    const leaseExpireTime = lease.leaseExpireTime;
    const leaseId = lease.leaseId;
    const leaseDurationSeconds = lease.leaseDurationSeconds;
    const leaseStatus = lease.leaseStatus;
    const leaseState = lease.leaseState;
    const leaseDuration = lease.leaseDurationType;
    const hasImmutabilityPolicy = this.getModelValue<boolean>(
      dbModel,
      "hasImmutabilityPolicy"
    );
    const hasLegalHold = this.getModelValue<boolean>(dbModel, "hasLegalHold");

    const ret: ContainerModel = {
      accountName,
      name,
      properties: {
        lastModified,
        etag,
        leaseStatus,
        leaseDuration,
        leaseState
      },
      leaseId,
      leaseBreakTime,
      leaseExpireTime,
      leaseDurationSeconds
    };

    if (metadata !== undefined) {
      ret.metadata = metadata;
    }

    if (containerAcl !== undefined) {
      ret.containerAcl = containerAcl;
    }

    if (publicAccess !== undefined) {
      ret.properties.publicAccess = publicAccess;
    }

    if (hasImmutabilityPolicy !== undefined) {
      ret.properties.hasImmutabilityPolicy = hasImmutabilityPolicy;
    }

    if (hasLegalHold !== undefined) {
      ret.properties.hasLegalHold = hasLegalHold;
    }

    return ret;
  }

  private convertContainerModelToDbModel(container: ContainerModel): any {
    const lease = new ContainerLeaseAdapter(container).toString();
    return {
      accountName: container.accountName,
      containerName: container.name,
      lastModified: container.properties.lastModified,
      etag: container.properties.etag,
      metadata: this.serializeModelValue(container.metadata),
      containerAcl: this.serializeModelValue(container.containerAcl),
      publicAccess: this.serializeModelValue(container.properties.publicAccess),
      lease,
      hasImmutabilityPolicy: container.properties.hasImmutabilityPolicy,
      hasLegalHold: container.properties.hasLegalHold
    };
  }

  private convertDbModelToFilterBlobModel(dbModel: BlobsModel): FilterBlobModel {
    return {
      containerName: this.getModelValue<string>(dbModel, "containerName", true),
      name: this.getModelValue<string>(dbModel, "blobName", true),
      tags: this.deserializeModelValue(dbModel, "blobTags")
    };
  }

  private convertDbModelToBlobModel(dbModel: BlobsModel): BlobModel {
    const contentProperties: IBlobContentProperties = this.convertDbModelToBlobContentProperties(
      dbModel
    );

    const lease = this.convertDbModelToLease(dbModel);

    return {
      accountName: this.getModelValue<string>(dbModel, "accountName", true),
      containerName: this.getModelValue<string>(dbModel, "containerName", true),
      name: this.getModelValue<string>(dbModel, "blobName", true),
      snapshot: this.getModelValue<string>(dbModel, "snapshot", true),
      isCommitted: this.getModelValue<boolean>(dbModel, "isCommitted", true),
      properties: {
        lastModified: this.getModelValue<Date>(dbModel, "lastModified", true),
        etag: this.getModelValue<string>(dbModel, "etag", true),
        leaseDuration: lease.leaseDurationType,
        creationTime: this.getModelValue<Date>(dbModel, "creationTime"),
        leaseState: lease.leaseState,
        leaseStatus: lease.leaseStatus,
        accessTier: this.getModelValue<Models.AccessTier>(
          dbModel,
          "accessTier"
        ),
        accessTierInferred: this.getModelValue<boolean>(
          dbModel,
          "accessTierInferred"
        ),
        accessTierChangeTime: this.getModelValue<Date>(
          dbModel,
          "accessTierChangeTime"
        ),
        blobSequenceNumber: this.getModelValue<number>(
          dbModel,
          "blobSequenceNumber"
        ),
        blobType: this.getModelValue<Models.BlobType>(dbModel, "blobType"),
        contentMD5: contentProperties
          ? this.restoreUint8Array(contentProperties.contentMD5)
          : undefined,
        contentDisposition: contentProperties
          ? contentProperties.contentDisposition
          : undefined,
        contentEncoding: contentProperties
          ? contentProperties.contentEncoding
          : undefined,
        contentLanguage: contentProperties
          ? contentProperties.contentLanguage
          : undefined,
        contentLength: contentProperties
          ? contentProperties.contentLength
          : undefined,
        contentType: contentProperties
          ? contentProperties.contentType
          : undefined,
        cacheControl: contentProperties
          ? contentProperties.cacheControl
          : undefined
      },
      leaseDurationSeconds: lease.leaseDurationSeconds,
      leaseBreakTime: lease.leaseBreakTime,
      leaseExpireTime: lease.leaseExpireTime,
      leaseId: lease.leaseId,
      persistency: this.deserializeModelValue(dbModel, "persistency"),
      committedBlocksInOrder: this.deserializeModelValue(
        dbModel,
        "committedBlocksInOrder"
      ),
      metadata: this.deserializeModelValue(dbModel, "metadata"),
      blobTags: this.deserializeModelValue(dbModel, "blobTags")
    };
  }

  private convertBlobModelToDbModel(blob: BlobModel): any {
    const contentProperties = this.convertBlobContentPropertiesToDbModel(
      blob.properties
    );

    const lease = this.convertLeaseToDbModel(new BlobLeaseAdapter(blob));
    return {
      accountName: blob.accountName,
      containerName: blob.containerName,
      blobName: blob.name,
      snapshot: blob.snapshot,
      blobType: blob.properties.blobType,
      blobSequenceNumber: blob.properties.blobSequenceNumber || null,
      isCommitted: blob.isCommitted,
      lastModified: blob.properties.lastModified,
      creationTime: blob.properties.creationTime || null,
      etag: blob.properties.etag,
      accessTier: blob.properties.accessTier || null,
      accessTierChangeTime: blob.properties.accessTierChangeTime || null,
      accessTierInferred: blob.properties.accessTierInferred || null,
      leaseBreakExpireTime: blob.leaseBreakTime || null,
      leaseExpireTime: blob.leaseExpireTime || null,
      leaseId: blob.leaseId || null,
      leasedurationNumber: blob.leaseDurationSeconds || null,
      leaseDuration: blob.properties.leaseDuration || null,
      leaseStatus: blob.properties.leaseStatus || null,
      leaseState: blob.properties.leaseState || null,
      ...lease,
      persistency: this.serializeModelValue(blob.persistency) || null,
      committedBlocksInOrder:
        this.serializeModelValue(blob.committedBlocksInOrder) || null,
      metadata: this.serializeModelValue(blob.metadata) || null,
      blobTags: this.serializeModelValue(blob.blobTags) || null,
      ...contentProperties
    };
  }

  private convertDbModelToBlobContentProperties(
    dbModel: BlobsModel
  ): IBlobContentProperties {
    return this.deserializeModelValue(dbModel, "contentProperties");
  }

  private convertBlobContentPropertiesToDbModel(
    contentProperties: IBlobContentProperties
  ): object {
    return {
      contentProperties:
        this.serializeModelValue({
          contentLength: contentProperties.contentLength,
          contentType: contentProperties.contentType,
          contentEncoding: contentProperties.contentEncoding,
          contentLanguage: contentProperties.contentLanguage,
          contentMD5: contentProperties.contentMD5,
          contentDisposition: contentProperties.contentDisposition,
          cacheControl: contentProperties.cacheControl
        }) || null
    };
  }

  private convertDbModelToLease(dbModel: ContainersModel | BlobsModel): ILease {
    const lease =
      (this.deserializeModelValue(dbModel, "lease") as ILease) || {};

    if (lease.leaseBreakTime && typeof lease.leaseBreakTime === "string") {
      lease.leaseBreakTime = new Date(lease.leaseBreakTime);
    }

    if (lease.leaseExpireTime && typeof lease.leaseExpireTime === "string") {
      lease.leaseExpireTime = new Date(lease.leaseExpireTime);
    }

    return lease;
  }

  private convertLeaseToDbModel(lease: ILease): object {
    let leaseString = "";
    if (
      lease instanceof ContainerLeaseAdapter ||
      lease instanceof BlobLeaseAdapter
    ) {
      leaseString = lease.toString();
    } else {
      leaseString = JSON.stringify(lease);
    }
    return { lease: leaseString };
  }

  private async getBlobWithLeaseUpdated(
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    context: Context,
    forceExist?: boolean,
    forceCommitted?: boolean,
    transaction?: Transaction
  ): Promise<BlobModel | undefined> {
    await this.checkContainerExist(context, account, container);

    const blobFindResult = await BlobsModel.findOne({
      where: {
        accountName: account,
        containerName: container,
        blobName: blob,
        snapshot
      },
      transaction
    });

    if (blobFindResult === null || blobFindResult === undefined) {
      if (forceExist === false) {
        return undefined;
      } else {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }
    }

    // Force exist if parameter forceExist is undefined or true
    const doc = this.convertDbModelToBlobModel(blobFindResult);
    if (forceExist === undefined || forceExist === true) {
      if (forceCommitted) {
        if (!doc || !(doc as BlobModel).isCommitted) {
          throw StorageErrorFactory.getBlobNotFound(context.contextId);
        }
      } else {
        if (!doc) {
          throw StorageErrorFactory.getBlobNotFound(context.contextId);
        }
      }
    } else {
      if (forceCommitted) {
        if (!doc || !(doc as BlobModel).isCommitted) {
          return undefined;
        }
      } else {
        if (!doc) {
          return undefined;
        }
      }
    }

    if (doc.properties) {
      doc.properties.contentMD5 = this.restoreUint8Array(
        doc.properties.contentMD5
      );
    }

    // Snapshot doesn't have lease
    if (snapshot !== undefined && snapshot !== "") {
      new BlobLeaseSyncer(doc).sync({
        leaseId: undefined,
        leaseExpireTime: undefined,
        leaseDurationSeconds: undefined,
        leaseBreakTime: undefined,
        leaseDurationType: undefined,
        leaseState: Models.LeaseStateType.Available, // TODO: Lease state & status should be undefined for snapshots
        leaseStatus: Models.LeaseStatusType.Unlocked // TODO: Lease state & status should be undefined for snapshots
      });
    } else {
      LeaseFactory.createLeaseState(new BlobLeaseAdapter(doc), context).sync(
        new BlobLeaseSyncer(doc)
      );
    }

    return doc;
  }

  public setBlobTag(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string | undefined,
    leaseAccessConditions: Models.LeaseAccessConditions | undefined,
    tags: Models.BlobTags | undefined,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<void> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: snapshot === undefined ? "" : snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel = this.convertDbModelToBlobModel(blobFindResult);

      LeaseFactory.createLeaseState(new BlobLeaseAdapter(blobModel), context)
        .validate(new BlobWriteLeaseValidator(leaseAccessConditions))
        .sync(new BlobWriteLeaseSyncer(blobModel));

      await BlobsModel.update(
        {
          blobTags: this.serializeModelValue(tags) || null,
          ...this.convertLeaseToDbModel(new BlobLeaseAdapter(blobModel))
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: snapshot === undefined ? "" : snapshot,
            deleting: 0
          },
          transaction: t
        }
      );
    });
  }

  public async getBlobTag(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    leaseAccessConditions?: Models.LeaseAccessConditions,
    modifiedAccessConditions?: Models.ModifiedAccessConditions
  ): Promise<Models.BlobTags | undefined> {
    return this.sequelize.transaction(async (t) => {
      await this.assertContainerExists(context, account, container, t);

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      validateReadConditions(context, modifiedAccessConditions, blobModel);

      if (!blobModel.isCommitted) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      ).validate(new BlobReadLeaseValidator(leaseAccessConditions));

      if (modifiedAccessConditions?.ifTags) {
        const validateFunction = generateQueryBlobWithTagsWhereFunction(context, modifiedAccessConditions?.ifTags, 'x-ms-if-tags');
        if (!validateFunction(blobModel)) {
          throw new Error("412");
        }
      }
      return blobModel.blobTags;
    });
  }

  /**
   * Get the tier setting from request headers.
   *
   * @private
   * @param {string} tier
   * @returns {(Models.AccessTier | undefined)}
   * @memberof BlobHandler
   */
  private parseTier(tier: string): Models.AccessTier | undefined {
    tier = tier.toLowerCase();
    if (tier === Models.AccessTier.Hot.toLowerCase()) {
      return Models.AccessTier.Hot;
    }
    if (tier === Models.AccessTier.Cool.toLowerCase()) {
      return Models.AccessTier.Cool;
    }
    if (tier === Models.AccessTier.Archive.toLowerCase()) {
      return Models.AccessTier.Archive;
    }
    if (tier === Models.AccessTier.Cold.toLowerCase()) {
      return Models.AccessTier.Cold;
    }
    return undefined;
  }  

  /**
   * Delete blob from SQL database.
   * For performance, we used to mark deleting+1, instead of really delete. But this take issue like #2563. So change to real delete.
   *
   * @private
   * @param {WhereOptions<any>} where
   * @param {Transaction} [t]
   * @returns {Promise<void>}
   * @memberof SqlBlobMetadataStore
   */
  private async deleteBlobFromSQL(where: WhereOptions<any>, t?: Transaction): Promise<void> {
    await BlobsModel.destroy({
      where,
      transaction: t
    });
    
    // // TODO: GC blobs under deleting status
    // await BlobsModel.update(
    //   {
    //     deleting: literal("deleting + 1")
    //   },
    //   {
    //     where,
    //     transaction: t
    //   }
    // );
  }

    /**
   * Delete block from SQL database.
   * For performance, we used to mark deleting+1, instead of really delete. But this take issue like #2563. So change to real delete.
   *
   * @private
   * @param {WhereOptions<any>} where
   * @param {Transaction} [t]
   * @returns {Promise<void>}
   * @memberof SqlBlobMetadataStore
   */
  private async deleteBlockFromSQL(where: WhereOptions<any>, t?: Transaction): Promise<void> {
     await BlocksModel.destroy({
      where,
      transaction: t
    });

    // TODO: GC blocks under deleting status
    // await BlocksModel.update(
    //   {
    //     deleting: literal("deleting + 1")
    //   },
    //   {
    //     where,
    //     transaction: t
    //   }
    // );
  }

  /**
   * Seal a blob.
   * @param context 
   * @param account 
   * @param container 
   * @param blob 
   * @param snapshot 
   * @param leaseAccessConditions
   * @param modifiedAccessConditions
   * @param appendPositionAccessConditions
   * @throws StorageErrorFactory.getBlobNotFound
   * @returns 
   */
  public async sealBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string | undefined,
    options: Models.AppendBlobSealOptionalParams,
  ): Promise<Models.BlobPropertiesInternal> {
    throw new NotImplementedinSQLError(context.contextId);
  }
}
