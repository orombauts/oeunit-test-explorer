USING Progress.Json.ObjectModel.JsonArray from propath.
using Progress.Json.ObjectModel.* from propath.
USING Progress.Json.ObjectModel.JsonObject FROM PROPATH.
USING Progress.Json.ObjectModel.JsonConstruct FROM PROPATH.
USING Progress.Json.ObjectModel.ObjectModelParser FROM PROPATH.
USING OEUnit.Util.Instance FROM PROPATH.
USING OEUnit.Runner.TestClassResult FROM PROPATH.
USING OEUnit.Runner.TestResult FROM PROPATH.
USING OEUnit.Util.List FROM PROPATH.
USING OEUnit.Runners.OEUnitRunner FROM PROPATH.
USING OEUnit.Runners.Manipulation.MethodFilter FROM PROPATH.

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

FUNCTION LogInfo RETURNS LOGICAL PRIVATE (LogMessage AS CHARACTER) FORWARD.
FUNCTION LogWarning RETURNS LOGICAL PRIVATE (LogMessage AS CHARACTER) FORWARD.
FUNCTION LogError RETURNS LOGICAL PRIVATE (LogMessage AS CHARACTER) FORWARD.

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

    DEFINE VARIABLE JsonRequest AS JsonObject NO-UNDO.

    DEFINE VARIABLE RequestType AS CHARACTER NO-UNDO.

    DEFINE VARIABLE ResponsePtr AS MEMPTR NO-UNDO.

    DEFINE VARIABLE BytesAvailable AS INTEGER NO-UNDO.

    DEFINE VARIABLE ResponseSize AS INT64 NO-UNDO.

    /* --------------------------------------------------------------------- */

    DO ON ERROR UNDO, LEAVE:
        ASSIGN
            ClientSocket = SELF
            BytesAvailable = IF ClientSocket:CONNECTED() THEN ClientSocket:GET-BYTES-AVAILABLE() ELSE 0
            .

        LogInfo(SUBSTITUTE("Bytes available: &1":U, BytesAvailable)).
    
        IF BytesAvailable <= 0
        THEN RUN RaiseError("No bytes available to read from client":U).

        LogInfo("Reading request from client...":U).

        RUN ReadRequest(ClientSocket, OUTPUT JsonRequest).

        RUN HandleRequest(JsonRequest, OUTPUT ResponsePtr).

        CATCH e AS Progress.Lang.AppError:
            RUN BuildErrorResponse(e, OUTPUT ResponsePtr).
        END CATCH.
    END.

    ASSIGN ResponseSize = IF ResponsePtr = ? THEN 0 ELSE GET-SIZE(ResponsePtr).

    IF ResponseSize <= 0
    THEN DO:
        LogError("Response message is empty").
    END.
    ELSE DO ON ERROR UNDO, LEAVE:
        /* Send response back to client */
        ClientSocket:WRITE(ResponsePtr, 1, ResponseSize).
        LogInfo(SUBSTITUTE("Responsed with &1 bytes":U, ResponseSize)).

        CATCH e AS Progress.Lang.AppError:
            RUN RaiseError(SUBSTITUTE("Failed to send response to client: &1":U, e:GetMessage(1))).
        END.
    END.

    FINALLY:
        /* Cleanup memptr resources */
        IF ClientSocket:CONNECTED()
        THEN DO:
            ClientSocket:DISCONNECT().
            DELETE OBJECT ClientSocket NO-ERROR.
        END.
        SET-SIZE(ResponsePtr) = 0.
    END FINALLY.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE ReadRequest PRIVATE:

    DEFINE INPUT PARAMETER ClientSocket AS HANDLE NO-UNDO.
    DEFINE OUTPUT PARAMETER JsonRequest AS JsonObject NO-UNDO.

    DEFINE VARIABLE BytesAvailable AS INTEGER NO-UNDO.
    
    DEFINE VARIABLE RequestPtr AS MEMPTR NO-UNDO.

    DEFINE VARIABLE MyParser AS ObjectModelParser NO-UNDO.
    DEFINE VARIABLE JsonParsed AS JsonConstruct NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN BytesAvailable = ClientSocket:GET-BYTES-AVAILABLE().

    IF BytesAvailable > 0
    THEN DO:
        SET-SIZE(RequestPtr) = BytesAvailable.
        ClientSocket:READ(RequestPtr, 1, BytesAvailable, 1) NO-ERROR.

        IF ClientSocket:BYTES-READ <> BytesAvailable OR GET-SIZE(RequestPtr) = 0
        THEN RUN RaiseError("Failed to read complete request from client":U).

        DO ON ERROR UNDO, THROW:
            ASSIGN
                JsonParsed = NEW ObjectModelParser():Parse(RequestPtr)
                JsonRequest = CAST(JsonParsed, JsonObject)
                .
            CATCH e AS Progress.Lang.AppError:
                RUN RaiseError(SUBSTITUTE("Failed to parse request: &1":U, e:GetMessage(1))).  
            END.
        END.
    END.

    FINALLY:
        SET-SIZE(RequestPtr) = 0.
    END FINALLY.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleRequest PRIVATE:

    DEFINE INPUT PARAMETER JsonRequest AS JsonObject NO-UNDO.
    DEFINE OUTPUT PARAMETER ResponsePtr AS MEMPTR NO-UNDO.

    DEFINE VARIABLE RequestType AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    IF JsonRequest = ? 
    THEN DO:
        RUN RaiseError("Received null request":U).
    END.

    ASSIGN RequestType = JsonRequest:GetCharacter("RequestType":U).

    CASE RequestType:
        WHEN "PING":U
        THEN RUN HandlePingRequest(OUTPUT ResponsePtr).
        
        WHEN "SHUTDOWN":U
        THEN RUN HandleShutdownRequest(OUTPUT ResponsePtr).
        
        WHEN "TEST":U
        THEN RUN HandleTestRequest(JsonRequest, OUTPUT ResponsePtr).
        
        OTHERWISE DO:
            RUN RaiseError(SUBSTITUTE("Unknown request type: &1":U, RequestType)).
        END.
    END CASE.

    CATCH e AS Progress.Lang.AppError:
        RUN BuildErrorResponse(e, OUTPUT ResponsePtr).
    END CATCH.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandlePingRequest:

    DEFINE OUTPUT PARAMETER Response AS MEMPTR NO-UNDO.

    /* --------------------------------------------------------------------- */

    RUN BuildResponse("PONG":U, OUTPUT Response).

    LogInfo("PING received, responding with PONG":U).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleShutdownRequest:

    DEFINE OUTPUT PARAMETER Response AS MEMPTR NO-UNDO.

    /* --------------------------------------------------------------------- */

    RUN BuildResponse("Shutdown initiated":U, OUTPUT Response).

    LogInfo("Shutdown requested":U).

    ASSIGN DoContinue = FALSE.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE HandleTestRequest:

    DEFINE INPUT PARAMETER TestRequest AS JsonObject NO-UNDO.
    DEFINE OUTPUT PARAMETER Response AS MEMPTR NO-UNDO.
    
    DEFINE VARIABLE TestFile AS CHARACTER NO-UNDO.
    DEFINE VARIABLE TestMethod AS CHARACTER NO-UNDO.
    DEFINE VARIABLE LogLevel AS CHARACTER NO-UNDO.

    DEFINE VARIABLE JsonOutput AS JsonObject NO-UNDO.

    DEFINE VARIABLE RunTestHasErrors AS LOGICAL NO-UNDO.

	DEFINE VARIABLE NumEntries AS INTEGER NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN
        TestFile = TestRequest:GetCharacter("TestFile":U)
        TestMethod = TestRequest:GetCharacter("TestMethod":U)
        LogLevel = TestRequest:GetCharacter("LogLevel":U).
	
    RUN RunTest(TestFile, TestMethod, OUTPUT JsonOutput).

    JsonOutput:WRITE(Response, FALSE).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE PerformTest PRIVATE:

    DEFINE INPUT PARAMETER TestFile AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER TestMethod AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER JsonOutput AS JsonObject NO-UNDO.

    DEFINE VARIABLE MethodIndex AS INTEGER NO-UNDO.
    DEFINE VARIABLE MethodName AS CHARACTER NO-UNDO.

    DEFINE VARIABLE TestObject AS Progress.Lang.Object NO-UNDO.
    DEFINE VARIABLE TestRunner AS OEUnitRunner NO-UNDO.

    /* --------------------------------------------------------------------- */
    
    IF TestFile = ? OR TestFile = "":U
    THEN RUN RaiseError("No test file specified in request":U).

    LogInfo(SUBSTITUTE("Running test file: &1, case(s): &2":U, TestFile,
        IF TestMethod > "":U THEN TestMethod ELSE "All")).

    ASSIGN TestRunner = NEW OEUnitRunner().

    IF TestMethod > "":U
    THEN DO:
        ASSIGN TestRunner:Filter = NEW MethodFilter(TestMethod).
    END.

    RUN CreateTestObject(TestFile, OUTPUT TestObject).

    TestRunner:RunTest(TestObject).

    RUN TransformTestResultsToJson(TestRunner:Results, OUTPUT JsonOutput).

    FINALLY:
        DELETE OBJECT TestObject NO-ERROR.
        DELETE OBJECT TestRunner NO-ERROR.
    END FINALLY.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE CreateTestObject:

    DEFINE INPUT PARAMETER TestFile AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER TestObject AS Progress.Lang.Object NO-UNDO.

    /* --------------------------------------------------------------------- */

    ASSIGN TestObject = Instance:FromFile(TestFile).

    CATCH e as Progress.Lang.AppError:
        RUN RaiseError(SUBSTITUTE("Failed to create test object from file &1: &2":U, TestFile, e:GetMessage(1))).
    END CATCH.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE TransformTestResultsToJson PRIVATE:

    DEFINE INPUT PARAMETER TestResults AS TestClassResult NO-UNDO.   
    DEFINE OUTPUT PARAMETER JsonOutput AS JsonObject NO-UNDO.

    DEFINE VARIABLE ResultIndex AS INTEGER NO-UNDO.
    DEFINE VARIABLE ErrorIndex AS INTEGER NO-UNDO.

    DEFINE VARIABLE InputFile AS CHARACTER NO-UNDO.
    DEFINE VARIABLE StackTrace AS CHARACTER NO-UNDO.

    DEFINE VARIABLE CallStack AS LONGCHAR NO-UNDO.

    DEFINE VARIABLE CurrentResult AS TestResult NO-UNDO.
    DEFINE VARIABLE ErrorList AS List NO-UNDO.

    DEFINE VARIABLE JsonSummary AS JsonObject NO-UNDO.
    DEFINE VARIABLE JsonTestCases AS JsonArray NO-UNDO.
    DEFINE VARIABLE JsonTestCase AS JsonObject NO-UNDO.
    DEFINE VARIABLE JsonErrorStack AS JsonArray NO-UNDO.
    
    /* --------------------------------------------------------------------- */

    ASSIGN
        JsonOutput = NEW JsonObject()
        JsonSummary = NEW JsonObject().

    JsonOutput:Add("Status":U, "COMPLETED":U).

    JsonSummary:Add("Errors":U, TestResults:CountTestsWithStatus(TestResult:StatusError)).
    JsonSummary:Add("Skipped":U, TestResults:CountTestsWithStatus(TestResult:StatusIgnored)).
    JsonSummary:Add("Total":U, TestResults:ResultCount).
    JsonSummary:Add("DurationMs":U, TestResults:GetDuration()).
    JsonSummary:Add("Failures":U, TestResults:CountTestsWithStatus(TestResult:StatusFailed)).
    JsonSummary:Add("Name":U, TestResults:GetName()).
    JsonOutput:Add("Summary":U, JsonSummary).

    JsonTestCases = NEW JsonArray().
    
    DO ResultIndex = 1 TO TestResults:ResultCount:
        JsonTestCase = NEW JsonObject().
        CurrentResult = TestResults:GetResult(ResultIndex).

        IF CurrentResult:GetErrors():Size > 0 
        THEN DO:
            JsonTestCase:Add("Status":U, "Failed":U).
            JsonTestCase:Add("Failure":U, CurrentResult:GetMessage()).
            ASSIGN
                ErrorList = currentResult:GetErrors()
                JsonErrorStack = NEW JsonArray().
            DO ErrorIndex = 1 TO ErrorList:Size:
                ASSIGN CallStack = CAST(ErrorList:Get(ErrorIndex), Progress.Lang.Error):CallStack.
                JsonErrorStack:Add(CallStack).
            END.
            JsonTestCase:Add("ErrorStack":U, JsonErrorStack).
        END.
        ELSE IF CurrentResult:GetStatus() = TestResult:StatusIgnored
        THEN DO:
            JsonTestCase:Add("Status":U, "Skipped":U).
        END.
        ELSE DO:
            JsonTestCase:Add("Status":U, "Passed":U).
        END.

        JsonTestCases:Add(JsonTestCase).
    END.

    JsonOutput:Add("TestCases":U, JsonTestCases).

    CATCH e as Progress.Lang.AppError:
        RUN RaiseError(SUBSTITUTE("Failed to create JSON test result output: &1":U, e:GetMessage(1))).
    END CATCH.

END PROCEDURE.

/*****************************************************************************/

PROCEDURE BuildErrorResponse PRIVATE:

    DEFINE INPUT PARAMETER e AS Progress.Lang.AppError NO-UNDO.
    DEFINE OUTPUT PARAMETER Response AS MEMPTR NO-UNDO.

    DEFINE VARIABLE JsonOutput AS JsonObject NO-UNDO.

    DEFINE VARIABLE ErrorMessage AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    LogError(SUBSTITUTE("Error: &1":U, ErrorMessage)).

    ASSIGN
        ErrorMessage = e:GetMessage(1)
        JsonOutput = NEW JsonObject().

    JsonOutput:Add("Status":U, "ERROR":U).
    JsonOutput:Add("Reply":U, ErrorMessage).

    JsonOutput:WRITE(Response, FALSE).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE BuildResponse PRIVATE:

    DEFINE INPUT PARAMETER ResponseString AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER Response AS MEMPTR NO-UNDO.

    DEFINE VARIABLE JsonOutput AS JsonObject NO-UNDO.

    /* --------------------------------------------------------------------- */
    
    ASSIGN JsonOutput = NEW JsonObject().

    JsonOutput:Add("Status":U, "OK":U).
    JsonOutput:Add("Reply":U, ResponseString).

    JsonOutput:WRITE(Response, FALSE).

END PROCEDURE.

/*****************************************************************************/

PROCEDURE CreateAliasesForDatabase PRIVATE:

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

PROCEDURE RaiseError PRIVATE:

    DEFINE INPUT PARAMETER LogMessage AS CHARACTER NO-UNDO.

    /* --------------------------------------------------------------------- */

    LogError(LogMessage).
    
    UNDO, THROW NEW Progress.Lang.AppError(LogMessage, 1).

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

FUNCTION LogInfo RETURNS LOGICAL PRIVATE(LogMessage AS CHARACTER):

    RETURN LogMessage("INFO":U, LogMessage).

END FUNCTION.

/*****************************************************************************/

FUNCTION LogError RETURNS LOGICAL PRIVATE(LogMessage AS CHARACTER):

    RETURN LogMessage("ERROR":U, LogMessage).

END FUNCTION.

/*****************************************************************************/

FUNCTION LogWarning RETURNS LOGICAL PRIVATE (LogMessage AS CHARACTER):

    RETURN LogMessage("WARNING":U, LogMessage).

END FUNCTION.
