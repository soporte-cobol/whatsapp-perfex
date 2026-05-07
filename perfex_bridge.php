<?php
/**
 * Bridge de Emergencia - Superando bloqueos de CodeIgniter
 */
header('Content-Type: application/json; charset=utf-8');

// Engañar al sistema de seguridad de Perfex/CodeIgniter
define('BASEPATH', __DIR__ . '/system/');
define('FCPATH', __DIR__ . '/');
define('APPPATH', __DIR__ . '/application/');

if (!file_exists(__DIR__ . '/application/config/app-config.php')) {
    die(json_encode(['error' => 'No se encontró app-config.php en ' . __DIR__]));
}

// Cargar configuración de base de datos directamente
require_once(__DIR__ . '/application/config/app-config.php');

// Validación de Token
$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? '';
if (empty($received_token) && isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $received_token = str_ireplace('Bearer ', '', $_SERVER['HTTP_AUTHORIZATION']);
}

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido']));
}

// Conexión DB
$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) die(json_encode(['error' => 'Error DB']));
mysqli_set_charset($conn, "utf8");

$action = $_GET['action'] ?? '';
$response = ['found' => false];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $search = (strlen($phone) > 7) ? substr($phone, -7) : $phone;
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$search%' OR cl.phonenumber LIKE '%$search%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        if ($row = mysqli_fetch_assoc($res)) $response = array_merge($row, ['found' => true]);
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' OR c.email LIKE '%$email%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        if ($row = mysqli_fetch_assoc($res)) $response = array_merge($row, ['found' => true]);
        break;

    case 'get_customer_by_vat':
        $vat = mysqli_real_escape_string($conn, trim($_GET['vat'] ?? ''));
        $sql = "SELECT userid as customerId, company FROM tblclients WHERE vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        if ($client = mysqli_fetch_assoc($res)) {
            $cid = $client['customerId'];
            $res_c = mysqli_query($conn, "SELECT id as contactId, firstname, lastname FROM tblcontacts WHERE userid = $cid ORDER BY is_primary DESC LIMIT 1");
            $contact = mysqli_fetch_assoc($res_c);
            $response = array_merge($client, $contact ? $contact : [], ['found' => true]);
        }
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id']);
        $res = mysqli_query($conn, "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid ORDER BY id DESC LIMIT 5");
        $invoices = [];
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $invoices[] = $row;
        }
        $response = $invoices;
        break;

    case 'get_projects':
        $cid = intval($_GET['customer_id']);
        $res = mysqli_query($conn, "SELECT id, name, status FROM tblprojects WHERE clientid = $cid LIMIT 3");
        $projects = [];
        while ($row = mysqli_fetch_assoc($res)) $projects[] = $row;
        $response = $projects;
        break;

    case 'get_contracts':
        $cid = intval($_GET['customer_id']);
        $res = mysqli_query($conn, "SELECT id, subject, contract_value, datestart, dateend FROM tblcontracts WHERE clientid = $cid LIMIT 3");
        $contracts = [];
        while ($row = mysqli_fetch_assoc($res)) $contracts[] = $row;
        $response = $contracts;
        break;
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);