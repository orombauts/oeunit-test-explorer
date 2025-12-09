/* OEUnitServer.p
 * Purpose: Persistent test server that listens on a socket for test requests
 * Command-line Parameters via SESSION:PARAMETER:
 *   Format: "port,logLevel,dbAlias1:alias1a|alias1b,dbAlias2:alias2a|alias2b,..."
 *   Example: "5555,info,genro:db1|db2,genrw:db3"
 *   LogLevel values: info (all messages), warning (warning+error), error (error only)
 */
 
BLOCK-LEVEL ON ERROR UNDO, THROW.

DEFINE VARIABLE PortNumber AS INTEGER NO-UNDO.
DEFINE VARIABLE LogLevel AS CHARACTER NO-UNDO.
DEFINE VARIABLE Server AS HANDLE NO-UNDO.
DEFINE VARIABLE SessionParameters AS CHARACTER NO-UNDO.
DEFINE VARIABLE ParameterIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE DoContinue AS LOGICAL NO-UNDO INITIAL TRUE.

FUNCTION LogInfo RETURNS LOGICAL (LogMessage AS CHARACTER) FORWARD.
FUNCTION LogWarning RETURNS LOGICAL (LogMessage AS CHARACTER) FORWARD.
FUNCTION LogError RETURNS LOGICAL (LogMessage AS CHARACTER) FORWARD.

/* --------------------------------------------------------------------- */

/* Parse SESSION:PARAMETER */
ASSIGN SessionParameters = SESSION:PARAMETER.

IF SessionParameters = ? OR SessionParameters = "":U
THEN DO:
    LogError("No parameters provided. Expected format: port,logLevel,dbAliases...":U).
    QUIT.
END.

/* First parameter is the port */
ASSIGN PortNumber = INTEGER(ENTRY(1, SessionParameters, ",":U)) NO-ERROR.

IF PortNumber = 0 OR PortNumber = ?
THEN DO:
    LogError(SUBSTITUTE("Invalid port number in SESSION:PARAMETER: &1":U, ENTRY(1, SessionParameters, ",":U))).
    QUIT.
END.

/* Second parameter is the log level */
IF NUM-ENTRIES(SessionParameters, ",":U) >= 2
THEN DO:
    ASSIGN LogLevel = ENTRY(2, SessionParameters, ",":U).
    IF LOOKUP(LogLevel, "info,warning,error":U) = 0
    THEN DO:
        ASSIGN LogLevel = "error":U.
        LogError(SUBSTITUTE("Invalid log level '&1', defaulting to 'error'. Valid values: info, warning, error":U, ENTRY(2, SessionParameters, ",":U))).
    END.
END.
ELSE DO:
    ASSIGN LogLevel = "error":U.
END.

LogInfo(SUBSTITUTE("Starting server on port &1 with log level &2":U, PortNumber, LogLevel)).

/* Create database aliases from SESSION:PARAMETER */
DO ParameterIndex = 3 TO NUM-ENTRIES(SessionParameters, ",":U):
    RUN CreateDatabaseAliasesFromParam(ENTRY(ParameterIndex, SessionParameters, ",":U)).
END.

/* Create server socket */
CREATE SERVER-SOCKET Server.

LogInfo(SUBSTITUTE("Setting up server on port &1":U, PortNumber)).

/* Set up server socket with callback procedure */
Server:SET-CONNECT-PROCEDURE("HandleClientConnect":U).

LogInfo(SUBSTITUTE("Enabling connections on port &1...":U, PortNumber)).

Server:ENABLE-CONNECTIONS("-S ":U + STRING(PortNumber)) NO-ERROR.

IF ERROR-STATUS:ERROR
THEN DO:
    LogError(SUBSTITUTE("Failed to enable connections on port &1: &2":U, PortNumber, ERROR-STATUS:GET-MESSAGE(1))).
    DELETE OBJECT Server NO-ERROR.
    QUIT.
END.

LogInfo(SUBSTITUTE("Server is now listening on port &1 - waiting for connections...":U, PortNumber)).

/* Main server loop - wait for connections */
DO WHILE DoContinue:
    WAIT-FOR CONNECT OF Server PAUSE 1.
    PROCESS EVENTS.
END.

/* Cleanup */
Server:DISABLE-CONNECTIONS() NO-ERROR.
DELETE OBJECT Server NO-ERROR.

LogInfo("Server stopped":U).

QUIT.

/*****************************************************************************/

PROCEDURE CreateDatabaseAliasesFromParam:

    DEFINE INPUT PARAMETER AliasParam AS CHARACTER NO-UNDO.
    
    DEFINE VARIABLE DbNameEntry AS CHARACTER NO-UNDO.
    DEFINE VARIABLE DbAliases AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    /* Parse format: "dbName:alias1|alias2|alias3" */
    IF INDEX(AliasParam, ":":U) = 0
    THEN DO:
        RETURN.
    END.
    
    ASSIGN
        DbNameEntry = ENTRY(1, AliasParam, ":":U)
        DbAliases = ENTRY(2, AliasParam, ":":U).
    
    IF DbNameEntry <> "":U AND DbAliases <> "":U
    THEN DO:
        LogInfo(SUBSTITUTE("Creating aliases for &1: &2":U, DbNameEntry, DbAliases)).
        RUN CreateAliasesForDatabase(DbNameEntry, DbAliases).
    END.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleClientConnect:

    DEFINE INPUT PARAMETER ClientSocket AS HANDLE NO-UNDO.

    /* --------------------------------------------------------------------- */

    LogInfo("Client connected":U).
    
    /* Set up the read response procedure - it will be called when data arrives */
    ClientSocket:SET-READ-RESPONSE-PROCEDURE("HandleClientRead":U).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleClientRead:

    DEFINE VARIABLE ClientSocket AS HANDLE NO-UNDO.
    DEFINE VARIABLE Request_ AS MEMPTR NO-UNDO.
    DEFINE VARIABLE Response_ AS MEMPTR NO-UNDO.
    DEFINE VARIABLE Request AS CHARACTER NO-UNDO.
    DEFINE VARIABLE Response AS CHARACTER NO-UNDO.
    DEFINE VARIABLE BytesAvailable AS INTEGER NO-UNDO.
    DEFINE VARIABLE BytesRead AS INTEGER NO-UNDO.

    /* --------------------------------------------------------------------- */

    /* Get the socket handle from the trigger */
    ASSIGN ClientSocket = SELF.
    
    LogInfo("HandleClientRead triggered":U).
    
    IF ClientSocket:CONNECTED()
    THEN DO:
        ASSIGN BytesAvailable = ClientSocket:GET-BYTES-AVAILABLE().
    END.
    
    IF BytesAvailable > 0
    THEN DO ON ERROR UNDO, LEAVE:
        /* Read request from client using memptr */
        SET-SIZE(Request_) = BytesAvailable.
        ClientSocket:READ(Request_, 1, BytesAvailable, 1) NO-ERROR.
        BytesRead = ClientSocket:BYTES-READ.
        
        LogInfo(SUBSTITUTE("Bytes read: &1":U, BytesRead)).
        
        IF BytesRead > 0
        THEN DO:
            ASSIGN Request = GET-STRING(Request_, 1, BytesRead).
            
            LogInfo(SUBSTITUTE("Received request: &1":U, Request)).
            
            /* Handle request */
            IF Request = "PING":U
            THEN DO:
                RUN HandlePingRequest(OUTPUT Response).
            END.
            ELSE IF Request = "SHUTDOWN":U
            THEN DO:
                RUN HandleShutdownRequest(OUTPUT Response).
            END.
            ELSE DO:
                RUN HandleTestRequest(Request, OUTPUT Response).
            END.
            
            /* Send response back to client */
            SET-SIZE(Response_) = LENGTH(Response) + 1.
            PUT-STRING(Response_, 1, LENGTH(Response)) = Response.
            ClientSocket:WRITE(Response_, 1, LENGTH(Response)) NO-ERROR.
            
            LogInfo(SUBSTITUTE("Response sent: &1":U, Response)).
        END.
    END.

    FINALLY:
        /* Cleanup memptr resources */
        IF ClientSocket:CONNECTED()
        THEN DO:
            ClientSocket:DISCONNECT().
            DELETE OBJECT ClientSocket NO-ERROR.
        END.
        SET-SIZE(Request_) = 0.
        SET-SIZE(Response_) = 0.
    END FINALLY.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandlePingRequest:

    DEFINE OUTPUT PARAMETER Response AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN Response = "PONG":U.

    LogInfo("PING received, responding with PONG":U).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleShutdownRequest:

    DEFINE OUTPUT PARAMETER Response AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN
        Response = "OK:SHUTDOWN":U
        DoContinue = FALSE.
    LogInfo("Shutdown requested":U).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleTestRequest:

    DEFINE INPUT PARAMETER Request AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER Response AS CHARACTER NO-UNDO.
    
    DEFINE VARIABLE RunnerPath AS CHARACTER NO-UNDO.
    DEFINE VARIABLE OutputDir AS CHARACTER NO-UNDO.
    DEFINE VARIABLE TestFile AS CHARACTER NO-UNDO.
    DEFINE VARIABLE LogLevel AS CHARACTER NO-UNDO.
	DEFINE VARIABLE NumEntries AS INTEGER NO-UNDO.

    /* --------------------------------------------------------------------- */

    /* Parse test request: "runnerPath,outputDir,testFile,logLevel" */
    ASSIGN NumEntries = NUM-ENTRIES(Request).
	
	IF NumEntries <> 4
	THEN DO:
	    RUN RaiseError("Invalid number of entries in request message":U).
	END.

	ASSIGN
		RunnerPath = ENTRY(1, Request)
		OutputDir = ENTRY(2, Request)
		TestFile = ENTRY(3, Request)
		LogLevel = ENTRY(4, Request)
		.
	
	LogInfo(SUBSTITUTE("Running test: &1~n  Output: &2~n  LogLevel: &3~n  Runner: &4":U, TestFile, OutputDir, LogLevel, RunnerPath)).
	
	/* Remove old output XML file */
	RUN DeleteOldOutputFile(OutputDir, TestFile).
	
	/* Run the test - pass parameters as INPUT parameters */
	RUN VALUE(RunnerPath) (OutputDir, TestFile, LogLevel, OUTPUT Response).

    RUN BuildSuccessResponse(OUTPUT Response).
    
	CATCH e AS Progress.Lang.AppError:
		RUN BuildErrorResponse(e, OUTPUT Response).
	END CATCH.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE DeleteOldOutputFile:

    DEFINE INPUT PARAMETER OutputDir AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER TestFile AS CHARACTER NO-UNDO.
    
    DEFINE VARIABLE TestClassName AS CHARACTER NO-UNDO.
    DEFINE VARIABLE OutputFile AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    FILE-INFO:FILE-NAME = OutputDir.
    IF FILE-INFO:FULL-PATHNAME <> ?
    THEN DO:
        /* Extract class name from test file path */
        TestClassName = REPLACE(SUBSTRING(TestFile, INDEX(TestFile, "test":U)), "~\":U, ".":U).
        TestClassName = REPLACE(TestClassName, ".cls":U, ".xml":U).
        OutputFile = OutputDir + (IF SUBSTRING(OutputDir, LENGTH(OutputDir), 1) = "~\":U THEN "":U ELSE "~\":U) + TestClassName.
        
        FILE-INFO:FILE-NAME = OutputFile.
        IF FILE-INFO:FULL-PATHNAME <> ?
        THEN DO:
            OS-DELETE VALUE(OutputFile).
            LogInfo(SUBSTITUTE("Deleted old output file: &1":U, OutputFile)).
        END.
    END.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE CreateAliasesForDatabase:

    DEFINE INPUT PARAMETER DbName_ AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER Aliases AS CHARACTER NO-UNDO.
    
    DEFINE VARIABLE NumAliases AS INTEGER NO-UNDO.
    DEFINE VARIABLE AliasEntryIndex AS INTEGER NO-UNDO.
    DEFINE VARIABLE AliasName AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    IF Aliases <> ? AND Aliases <> "":U
    THEN DO:
        /* Aliases are separated by pipe (|) */
        ASSIGN NumAliases = NUM-ENTRIES(Aliases, "|":U).
        
        DO AliasEntryIndex = 1 TO NumAliases:
            ASSIGN AliasName = ENTRY(AliasEntryIndex, Aliases, "|":U).
            
            IF AliasName <> "":U
            THEN DO:
                CREATE ALIAS VALUE(AliasName) FOR DATABASE VALUE(DbName_) NO-ERROR.
                
                IF ERROR-STATUS:ERROR
                THEN DO:
                    LogWarning(SUBSTITUTE("Failed to create alias &1 for database &2: &3":U, AliasName, DbName_, ERROR-STATUS:GET-MESSAGE(1))).
                END.
                ELSE DO:
                    LogInfo(SUBSTITUTE("Created alias: &1 for database: &2":U, AliasName, DbName_)).
                END.
            END.
        END.
    END.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE RaiseError:

    DEFINE INPUT PARAMETER LogMessage AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    LogError(LogMessage).
    
    UNDO, THROW NEW Progress.Lang.AppError(LogMessage, 1).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE BuildSuccessResponse:

    DEFINE OUTPUT PARAMETER Response AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

	ASSIGN Response = "OK:COMPLETE":U.

	LogInfo("Test completed successfully":U).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE BuildErrorResponse:

    DEFINE INPUT PARAMETER e AS Progress.Lang.AppError NO-UNDO.
    DEFINE OUTPUT PARAMETER Response AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN Response = "ERROR: ":U + e:GetMessage(1).
    
    LogError(SUBSTITUTE("Test execution error: &1":U, e:GetMessage(1))).

END PROCEDURE.

/*****************************************************************************/

FUNCTION LogMessage RETURNS LOGICAL(LogType AS CHARACTER, LogMessage AS CHARACTER):

    DEFINE VARIABLE ShouldLog AS LOGICAL NO-UNDO INITIAL FALSE.

    /* --------------------------------------------------------------------- */

    /* Determine if message should be logged based on current log level */
    CASE LogLevel:
        WHEN "info":U
        THEN DO:
            ASSIGN ShouldLog = TRUE.
        END.
        WHEN "warning":U
        THEN DO:
            ASSIGN ShouldLog = (LogType = "WARNING":U OR LogType = "ERROR":U).
        END.
        WHEN "error":U
        THEN DO:
            ASSIGN ShouldLog = (LogType = "ERROR":U).
        END.
        OTHERWISE DO:
            ASSIGN ShouldLog = TRUE.
        END.
    END CASE.

    IF ShouldLog
    THEN DO:
        MESSAGE SUBSTITUTE("&1 [OEUnitServer] &2: &3":U, NOW, LogType, LogMessage).
    END.

    RETURN TRUE.

END FUNCTION.

/*****************************************************************************/

FUNCTION LogInfo RETURNS LOGICAL(LogMessage AS CHARACTER):

    RETURN LogMessage("INFO":U, LogMessage).

END FUNCTION.

/*****************************************************************************/

FUNCTION LogError RETURNS LOGICAL(LogMessage AS CHARACTER):

    RETURN LogMessage("ERROR":U, LogMessage).

END FUNCTION.

/*****************************************************************************/

FUNCTION LogWarning RETURNS LOGICAL(LogMessage AS CHARACTER):

    RETURN LogMessage("WARNING":U, LogMessage).

END FUNCTION.

